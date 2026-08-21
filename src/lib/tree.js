import * as THREE from 'three';
import RNG from './rng';
import { Branch } from './branch';
import { Billboard, TreeType } from './enums';
import TreeOptions from './options';
import { loadPreset } from './presets/index';
import { Trellis } from './trellis';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

/**
 * Yields to the browser long enough for pending DOM updates to paint before
 * blocking work resumes on the main thread. Used by the chunked async
 * generation path so large trees don't freeze the UI while they build.
 * @returns {Promise<void>}
 */
function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export class Tree extends THREE.Group {
  /**
   * @type {RNG}
   */
  rng;

  /**
   * @type {TreeOptions}
   */
  options;

  /**
   * @type {Branch[]}
   */
  branchQueue = [];

  /**
   * @param {TreeOptions} params
   */
  constructor(options = new TreeOptions()) {
    super();
    this.name = 'Tree';
    this.branchesMesh = new THREE.Mesh();
    this.leavesMesh = new THREE.Mesh();
    this.trellisMesh = null;
    this.lod = null;
    this.skeleton = null;
    this.selectedBranchIndex = null;

    // Highlight overlay for the branch picked in the editor. Rebuilt on
    // selection; never participates in RNG or meshing of the tree itself.
    this.selectionMesh = new THREE.Mesh();
    this.selectionMesh.name = 'BranchSelection';
    this.selectionMesh.visible = false;
    this.selectionMesh.material = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffaa00,
      emissiveIntensity: 0.9,
      metalness: 0,
      roughness: 1,
      transparent: true,
      opacity: 0.85,
      depthTest: true,
    });

    this.add(this.branchesMesh);
    this.add(this.leavesMesh);
    this.add(this.selectionMesh);
    this.options = options;
  }

  update(elapsedTime) {
    const leafShader = this.leavesMesh.material.userData.shader;
    if (leafShader) {
      leafShader.uniforms.uTime.value = elapsedTime;
    }
  }

  /**
   * Loads a preset tree from JSON
   * @param {string} preset
   */
  loadPreset(name) {
    const json = loadPreset(name);
    this.loadFromJson(json);
  }

  /**
   * Loads a tree from JSON
   * @param {TreeOptions} json
   */
  loadFromJson(json) {
    this.options.copy(json);
    this.generate();
  }

  /**
   * @typedef {Object} LODDetail
   * @property {number} [sectionStride=1] Sample every Nth section ring; the
   *   first and last rings are always kept so branch endpoints stay put
   * @property {number} [segmentFactor=1] Radial segment multiplier;
   *   segments = max(3, round(segmentCount * segmentFactor))
   * @property {number} [leafStride=1] Keep every Nth leaf
   * @property {number} [leafScale=1] Size multiplier for the kept leaves,
   *   typically 1/sqrt(kept fraction) to preserve canopy coverage
   * @property {string} [billboard] Billboard mode override for this level
   *   ('single' or 'double'); defaults to options.leaves.billboard
   */

  /**
   * @typedef {Object} LODLevel
   * @property {number} distance Camera distance at which this level activates
   * @property {number} [hysteresis] Switch hysteresis as a fraction of distance
   * @property {LODDetail} [detail] Meshing detail for this level
   */

  /**
   * Default levels for generateLODs(). LOD1 is roughly 40% of the full
   * triangle count, LOD2 roughly 20%.
   * @type {LODLevel[]}
   */
  static defaultLODLevels = [
    { distance: 0, detail: {} },
    {
      distance: 100,
      hysteresis: 0.05,
      detail: {
        sectionStride: 3,
        segmentFactor: 0.75,
        leafStride: 2,
        // Slightly under the area-preserving sqrt(2): individual leaves are
        // still resolvable at this distance, so a full compensation reads as
        // "bigger leaves" rather than "same canopy".
        leafScale: 1.25,
      },
    },
    {
      distance: 250,
      hysteresis: 0.05,
      detail: {
        sectionStride: 6,
        segmentFactor: 0.4,
        leafStride: 2,
        // Deliberately under-compensated: full coverage compensation for the
        // thinning + single billboard would need 2x scale, which reads as
        // balloon leaves. A slightly sparser canopy with natural-size leaves
        // looks better at this distance (fogged, 250+ units in the demo).
        leafScale: 1.3,
        billboard: Billboard.Single,
      },
    },
  ];

  /**
   * Birth windows for the growth animation, indexed by branch level. Each
   * window is the progress range (0..1) over which that level goes from a
   * bud to full size. Overlapping windows keep the growth continuous: the
   * trunk (level 0) finishes first, then level 1, then the twigs — the
   * classic "up the trunk, out the branches, into the twigs" reveal.
   * @type {{start: number, end: number}[]}
   */
  static growthWindows = [
    { start: 0.00, end: 0.34 }, // level 0 — trunk
    { start: 0.24, end: 0.60 }, // level 1
    { start: 0.48, end: 0.82 }, // level 2
    { start: 0.66, end: 1.00 }, // level 3+ (terminal twigs, user branches)
  ];

  /**
   * Generate a new tree
   */
  generate() {
    this.#clearLOD();
    this.#generateSkeleton();

    const buffers = this.#meshSkeleton();
    this.branches = buffers.branches;
    this.leaves = buffers.leaves;

    this.createBranchesGeometry();
    this.createLeavesGeometry();
    this.createTrellis();
    this.#applyScale();
    this.#applyDecals();
  }

  /**
   * Async variant of {@link generate} that yields to the browser between
   * chunks of skeleton growth and meshing. Large trees build incrementally
   * across animation frames instead of blocking the main thread in one long
   * synchronous burst — this is what keeps the UI responsive while a preset
   * is loading. The resulting geometry is identical to generate().
   * @returns {Promise<void>}
   */
  async generateAsync() {
    this.#clearLOD();
    await this.#generateSkeletonAsync();

    const buffers = await this.#meshSkeletonAsync();
    this.branches = buffers.branches;
    this.leaves = buffers.leaves;

    this.createBranchesGeometry();
    this.createLeavesGeometry();
    this.createTrellis();
    this.#applyScale();
    this.#applyDecals();
  }

  /**
   * Applies the global proportional scale (options.scale) as a uniform group
   * transform. Because it scales the whole group by one factor, the trunk and
   * every branch level grow/shrink together — there is no scenario where the
   * trunk scales but twigs don't. Cheap, and correct by construction.
   */
  #applyScale() {
    const s = this.options.scale;
    this.scale.setScalar(typeof s === 'number' && s > 0 ? s : 1);
  }

  /**
   * Re-projects all decals (options.decals) onto the current branch mesh.
   * Each decal descriptor stores its position/normal in the tree's LOCAL space
   * (so it survives regeneration and re-scales with the tree); here we transform
   * to world space for the projector, build a conforming DecalGeometry, and add
   * it as a child of the branch mesh. Cheap (a handful of decals) and idempotent
   * — safe to call on every generate.
   */
  #decalTexCache = new Map();
  #applyDecals() {
    // Drop previously projected decal meshes (keep the descriptor list intact).
    if (this.decalGroup) {
      this.branchesMesh.remove(this.decalGroup);
      this.decalGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.decalGroup = null;
    }

    const decals = this.options.decals;
    if (!decals || !decals.length) return;

    this.updateMatrixWorld(true);
    const meshWorld = this.branchesMesh.matrixWorld;

    const group = new THREE.Group();
    group.name = 'Decals';

    for (const d of decals) {
      if (!d || !d.dataURL) continue;
      const localPos = new THREE.Vector3().fromArray(d.position);
      const worldPos = localPos.clone().applyMatrix4(meshWorld);
      const localNormal = new THREE.Vector3().fromArray(d.normal).normalize();
      const worldNormal = localNormal.clone().transformDirection(meshWorld).normalize();

      const orientation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          worldNormal,
        ),
      );
      orientation.z += (d.rotation || 0);

      const size = new THREE.Vector3(d.size, d.size, d.depth ?? d.size * 0.5);

      let geo;
      try {
        geo = new DecalGeometry(this.branchesMesh, worldPos, orientation, size);
      } catch (e) {
        continue;
      }
      if (!geo.attributes.position || geo.attributes.position.count === 0) continue;

      let tex = this.#decalTexCache.get(d.dataURL);
      if (!tex) {
        tex = new THREE.TextureLoader().load(d.dataURL);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.premultiplyAlpha = true;
        this.#decalTexCache.set(d.dataURL, tex);
      }

      const mat = new THREE.MeshStandardMaterial({
        name: 'decal',
        map: tex,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        roughness: 1,
        metalness: 0,
      });

      const dm = new THREE.Mesh(geo, mat);
      dm.name = 'Decal';
      group.add(dm);
    }

    if (group.children.length) {
      this.branchesMesh.add(group);
      this.decalGroup = group;
    }
  }

  /**
   * Adds a decal descriptor from a world-space surface hit and immediately
   * re-projects all decals. The descriptor stores LOCAL-space position and
   * normal (converted here), so it survives regeneration and scales with the
   * tree. No regeneration is needed — decals are re-projected in place.
   * @param {THREE.Vector3} worldPoint raycast hit point (world space)
   * @param {THREE.Vector3} worldNormal raycast hit face normal (world space)
   * @param {{dataURL: string, size?: number, depth?: number, rotation?: number}} opts
   * @returns {object|null} the stored descriptor
   */
  addDecalAt(worldPoint, worldNormal, opts) {
    if (!this.branchesMesh || !opts || !opts.dataURL) return null;
    this.updateMatrixWorld(true);
    const meshWorld = this.branchesMesh.matrixWorld;
    const meshInv = meshWorld.clone().invert();

    const localPos = worldPoint.clone().applyMatrix4(meshInv);
    const localNormal = worldNormal.clone().transformDirection(meshInv).normalize();

    const descriptor = {
      dataURL: opts.dataURL,
      position: [localPos.x, localPos.y, localPos.z],
      normal: [localNormal.x, localNormal.y, localNormal.z],
      size: opts.size ?? 0.8,
      depth: opts.depth,
      rotation: opts.rotation ?? Math.random() * Math.PI * 2,
    };
    (this.options.decals || (this.options.decals = [])).push(descriptor);
    this.#applyDecals();
    return descriptor;
  }

  /**
   * Removes all decal descriptors and their projected meshes.
   */
  clearDecals() {
    this.options.decals = [];
    if (this.decalGroup) {
      this.branchesMesh.remove(this.decalGroup);
      this.decalGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.decalGroup = null;
    }
  }

  /**
   * Generates the tree as a set of levels of detail hosted in a THREE.LOD
   * object inside this group. The renderer switches levels automatically
   * based on camera distance. All levels share one bark and one leaf
   * material, so update() animates wind at every level.
   * @param {LODLevel[]} levels Level descriptors, in any order
   */
  generateLODs(levels = Tree.defaultLODLevels) {
    this.#clearLOD();
    this.#generateSkeleton();

    const barkMaterial = this.#createBarkMaterial();
    const leafMaterial = this.#createLeafMaterial();

    this.lod = new THREE.LOD();
    this.lod.name = 'TreeLOD';

    // THREE.LOD sorts its levels by distance internally, so sort here too and
    // let the nearest level own the reused meshes regardless of input order.
    const ordered = [...levels].sort(
      (a, b) => (a.distance ?? 0) - (b.distance ?? 0),
    );

    ordered.forEach((level, index) => {
      const buffers = this.#meshSkeleton(level.detail ?? {});

      let branchesMesh, leavesMesh;
      if (index === 0) {
        // Reuse the existing meshes for the closest level so update(),
        // traversal and the vertex/triangle count getters keep working.
        this.branches = buffers.branches;
        this.leaves = buffers.leaves;
        branchesMesh = this.branchesMesh;
        leavesMesh = this.leavesMesh;
        branchesMesh.geometry.dispose();
        branchesMesh.material.dispose();
        leavesMesh.geometry.dispose();
        leavesMesh.material.dispose();
      } else {
        branchesMesh = new THREE.Mesh();
        leavesMesh = new THREE.Mesh();
      }

      branchesMesh.geometry = this.#buildBufferGeometry(buffers.branches);
      branchesMesh.material = barkMaterial;
      leavesMesh.geometry = this.#buildBufferGeometry(buffers.leaves);
      leavesMesh.material = leafMaterial;

      for (const mesh of [branchesMesh, leavesMesh]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }

      const group = new THREE.Group();
      group.add(branchesMesh, leavesMesh);
      this.lod.addLevel(group, level.distance ?? 0, level.hysteresis ?? 0);
    });

    this.add(this.lod);
    this.createTrellis();
    this.#applyScale();
    this.#applyDecals();
  }

  /**
   * Builds branch and leaf geometry at the given detail level without
   * modifying the tree's own meshes. Useful for external instancing or
   * custom LOD systems. Reuses the current skeleton, generating one first
   * if none exists.
   * @param {LODDetail} detail
   * @returns {{ branches: THREE.BufferGeometry, leaves: THREE.BufferGeometry }}
   */
  createGeometry(detail = {}) {
    if (!this.skeleton) {
      this.#generateSkeleton();
    }
    const buffers = this.#meshSkeleton(detail);
    return {
      branches: this.#buildBufferGeometry(buffers.branches),
      leaves: this.#buildBufferGeometry(buffers.leaves),
    };
  }

  /**
   * Async variant of {@link createGeometry} that yields to the browser while
   * meshing, so an LOD preview re-build on a large tree doesn't freeze the UI.
   * @param {LODDetail} detail
   * @returns {Promise<{ branches: THREE.BufferGeometry, leaves: THREE.BufferGeometry }>}
   */
  async createGeometryAsync(detail = {}) {
    if (!this.skeleton) {
      this.#generateSkeleton();
    }
    const buffers = await this.#meshSkeletonAsync(detail);
    return {
      branches: this.#buildBufferGeometry(buffers.branches),
      leaves: this.#buildBufferGeometry(buffers.leaves),
    };
  }

  /**
   * Builds a standalone THREE.Scene that reproduces the tree's full-detail
   * geometry as a SKELETON hierarchy of branch meshes plus leaf-group meshes,
   * together with an AnimationClip whose per-node scale tracks grow the tree
   * from sapling to full size using the SAME birth windows and the SAME
   * length/radius curves as the in-app growth animation (trunk → branches →
   * twigs, leaves popping in as their parent branch matures). Feed `scene` +
   * `clip` to GLTFExporter's `animations` option to bake the growth into a
   * GLB.
   *
   * The tree must currently hold a FULL (progress=1) skeleton — the caller
   * regenerates with growth.progress=1 first (or with growth disabled) and
   * restores afterwards.
   *
   * Hierarchy & coordinate spaces (this is what keeps the GLB animation
   * faithful to the in-app one):
   *  - Every branch node is PARENTED to its skeleton parent (trunk → root
   *    rig), with a local transform placed at the attachment point in the
   *    parent's frame. A growing parent therefore carries its children along,
   *    so twigs climb the trunk instead of flying in from the world origin.
   *  - Branch geometry is baked in its own LOCAL frame (origin = attachment
   *    point, +Z = first-segment direction), full detail, independent of any
   *    active LOD preview.
   *  - Each branch has a NON-UNIFORM scale track (radius, radius, length)
   *    whose samples replicate #growthLevel exactly: hidden before birth,
   *    a ~36% bud appears at 8% into the birth window, then smoothsteps to
   *    full size by the window end. Level-0 branches (trunk) are born with
   *    the clip, so t=0 already shows a sapling trunk.
   *  - A small ring of "sapling leaves" on the young trunk carries the
   *    "leaves exist the whole time" feel; regular leaves are grouped by
   *    their nearest branch and pop in once that branch is ~85% elongated.
   * @param {{duration?: number, scaleStart?: number, smallOptions?: object,
   *          sampleAt?: (progress: number) => object}} [opts]
   *   Animation length in seconds (default 12); scaleStart optionally animates
   *   the whole tree from a sapling scale up to 1 (e.g. the small-tree JSON's
   *   scale); smallOptions is the small-tree snapshot so each branch can grow
   *   from its young size to its full size instead of only appearing via the
   *   birth window; sampleAt (GrowthController#snapshotAt) enables EMPIRICAL
   *   baking — the runtime skeleton is regenerated at a series of progress
   *   values and every branch's measured attach point / length / radius is
   *   baked into the tracks, so the exported animation matches the scene by
   *   construction (sibling attach sliding, evergreen taper and all).
   * @returns {{scene: THREE.Scene, clip: THREE.AnimationClip, duration: number}}
   */
  createGrowthExportScene(opts = {}) {
    const duration = opts.duration ?? 12;
    // fullAtStart: the animation begins from the complete small-tree state
    // (all branches already visible, leaves present) instead of a bare
    // seedling. This is the mode used when exporting from an uploaded
    // small-tree JSON to an uploaded big-tree JSON.
    const fullAtStart = opts.fullAtStart === true;

    // Dual-tree mode: the small and big JSONs have genuinely different
    // topologies (e.g. one is procedural with many children, the other is
    // hand-edited with user branches and overrides). The only robust way to
    // make the first frame look exactly like the small tree and the last
    // frame look exactly like the big tree is to build BOTH trees and cross-
    // fade their scales. The small tree stays visible for the first ~60% of
    // the clip while the big tree grows from the small height to full height;
    // then the small tree shrinks away as the big tree takes over.
    if (opts.dualTree === true && opts.smallOptions) {
      return this.#createDualTreeExportScene(opts);
    }

    const scene = new THREE.Scene();
    scene.name = 'TreeGrowth';

    const root = new THREE.Group();
    root.name = 'Tree';
    const treeScale = this.options.scale;
    if (typeof treeScale === 'number' && treeScale > 0) {
      root.scale.setScalar(treeScale);
    }
    scene.add(root);

    // A dedicated rig under the static-scaled root: the optional whole-tree
    // scaleStart → 1 animation lives here, so it never collides with the
    // tree's own static options.scale on the root node.
    const rig = new THREE.Group();
    rig.name = 'GrowthRig';
    root.add(rig);

    const barkMaterial = this.branchesMesh?.material ?? this.#createBarkMaterial();
    const leafMaterial = this.leavesMesh?.material ?? this.#createLeafMaterial();

    const tracks = [];
    const branches = this.skeleton.branches;

    // Per-level size ratios between the young (small) tree and the full (big)
    // tree. These fold the small->big parameter interpolation into the GLB
    // animation so a branch is born at its young size and grows to full size.
    const bigOpts = this.options;
    const smallOpts = opts.smallOptions;
    const maxLevel = Math.max(
      0,
      ...branches.map((b) => b.level),
    );
    const uniformScale = opts.uniformScale === true;
    const levelRatios = [];
    if (smallOpts && smallOpts.branch && bigOpts.branch) {
      const smallL = smallOpts.branch.length || {};
      const bigL = bigOpts.branch.length || {};
      const smallR = smallOpts.branch.radius || {};
      const bigR = bigOpts.branch.radius || {};
      for (let lvl = 0; lvl <= maxLevel; lvl++) {
        const bl = typeof bigL[lvl] === 'number' ? bigL[lvl] : 1;
        const sl = typeof smallL[lvl] === 'number' ? smallL[lvl] : bl;
        const br = typeof bigR[lvl] === 'number' ? bigR[lvl] : 1;
        const sr = typeof smallR[lvl] === 'number' ? smallR[lvl] : br;
        levelRatios[lvl] = {
          lScale: uniformScale ? 1 : (bl > 0 ? sl / bl : 1),
          rScale: uniformScale ? 1 : (br > 0 ? sr / br : 1),
        };
      }
    }
    while (levelRatios.length <= maxLevel) {
      levelRatios.push({ lScale: 1, rScale: 1 });
    }

    // Leaf size ratio
    let leafSizeRatio = 1;
    if (smallOpts && smallOpts.leaves && bigOpts.leaves) {
      const bs = typeof bigOpts.leaves.size === 'number' ? bigOpts.leaves.size : 1;
      const ss = typeof smallOpts.leaves.size === 'number' ? smallOpts.leaves.size : bs;
      leafSizeRatio = bs > 0 ? ss / bs : 1;
    }

    // Small→big parameter interpolation, mirroring GrowthController's
    // snapshotAt: per-level params lerp with a smoothstep ease over the
    // WHOLE timeline (the trunk keeps thickening/lengthening long after its
    // birth window closes — the sapling's params only reach the big tree's
    // at p = 1).
    const easeP = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

    // Buttress roots have no birth window at runtime: they exist at full
    // length from the very first frame (their thickness rides the trunk's
    // base radius). Detect them by path so their export track matches.
    const isRootBranch = (sb) => /\.root\d+$/.test(sb.path);

    // ---- per-branch local frame: origin = attachment point, zAxis = first
    // ---- segment direction, x/y span the cross-section (so a non-uniform
    // ---- scale (r, r, l) maps onto radius / length like #growthLevel).
    const frameOf = (sb) => {
      const s = sb.sections;
      const origin = s[0].origin;
      const dir = new THREE.Vector3(0, 1, 0);
      if (s.length > 1) dir.subVectors(s[1].origin, s[0].origin);
      if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
      dir.normalize();
      const zAxis = dir;
      const xAxis = new THREE.Vector3(0, 1, 0).cross(zAxis);
      if (xAxis.lengthSq() < 1e-10) xAxis.set(1, 0, 0);
      xAxis.normalize();
      const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
      const R = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
      return { origin, xAxis, yAxis, zAxis, R, Rt: R.clone().transpose() };
    };

    /** world → frame: p' = Rᵀ(p − origin); mutates v. */
    const toLocal = (frame, v) => v.sub(frame.origin).applyMatrix4(frame.Rt);

    /** Rewrites a buffers array's verts/normals from world to frame coords. */
    const localizeBuffers = (buffers, frame) => {
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let i = 0; i < buffers.verts.length; i += 3) {
        v.set(buffers.verts[i], buffers.verts[i + 1], buffers.verts[i + 2])
          .sub(frame.origin).applyMatrix4(frame.Rt);
        buffers.verts[i] = v.x;
        buffers.verts[i + 1] = v.y;
        buffers.verts[i + 2] = v.z;
        n.set(buffers.normals[i], buffers.normals[i + 1], buffers.normals[i + 2])
          .applyMatrix4(frame.Rt);
        buffers.normals[i] = n.x;
        buffers.normals[i + 1] = n.y;
        buffers.normals[i + 2] = n.z;
      }
    };

    // ---- skeleton parent map: "0.3" → "0", "0.2c" → "0.2", "0c" → "0",
    // ---- "0@u1" → "0", "0.root0" → "0"; null = root rig.
    const parentPathOf = (path) => {
      if (path.includes('@')) return path.slice(0, path.lastIndexOf('@'));
      const idx = path.lastIndexOf('.');
      if (idx < 0) {
        // No dot: only possible as a bare tip continuation ("0c" → "0").
        return /[a-z]+$/i.test(path) ? path.replace(/[a-z]+$/i, '') : null;
      }
      const last = path.slice(idx + 1);
      if (/[a-z]+$/i.test(last)) {
        return path.slice(0, idx) + '.' + last.replace(/[a-z]+$/i, '');
      }
      return path.slice(0, idx);
    };
    const byPath = new Map();
    branches.forEach((sb, i) => { if (!byPath.has(sb.path)) byPath.set(sb.path, i); });
    const parentIndex = (i) => {
      let p = parentPathOf(branches[i].path);
      while (p != null && !byPath.has(p)) p = parentPathOf(p);
      return p == null ? -1 : byPath.get(p);
    };

    const frames = branches.map(frameOf);
    const worldMat = branches.map((_, i) => {
      const f = frames[i];
      return new THREE.Matrix4().makeBasis(f.xAxis, f.yAxis, f.zAxis).setPosition(f.origin);
    });
    const invWorldMat = worldMat.map((m) => m.clone().invert());

    // ---- Empirical baking (optional) -------------------------------------
    // When opts.sampleAt is provided (the app passes GrowthController's
    // snapshotAt), regenerate the runtime skeleton at a series of progress
    // values and bake the MEASURED attachment / length / radius of every
    // branch into the tracks. The exported animation then matches the scene
    // BY CONSTRUCTION, including behaviours no closed-form curve reproduces:
    // sibling attach points sliding up the parent as the level fills in,
    // the evergreen (1 - start) length taper, radii read off the parent's
    // CURRENT sections, and the small→big parameter interpolation itself.
    const sampleAt = typeof opts.sampleAt === 'function' ? opts.sampleAt : null;
    /**
     * Measured per-branch quantities at every sample:
     *  - dir: the FIRST-SECTION direction (sec1 − sec0, normalized). The
     *    baked rotation aligns the node's rest z-axis to this — at p = 1 the
     *    runtime first direction equals the rest one, so the final pose is
     *    EXACTLY the rest transform (no residual rotation, unlike a
     *    chord-aligned rotation, which tilts curved branches away from
     *    their rest pose even at p = 1).
     *  - wz: the tip's signed projection onto dir. The baked z-scale is
     *    wz / restZProj, which places the tip correctly along the branch
     *    axis and is exactly 1 at p = 1 by construction.
     *  - chord: |tip − attach|, a robust always-positive fallback length
     *    factor for branches whose rest spine curls past perpendicular
     *    (restZProj ≈ 0 makes the projection ratio unstable).
     */
    /** progress → Map(path → {attach, dir, wz, chord, baseRad}) of the runtime tree. */
    let sampleSeries = null;
    /** path → Map(progress → measured length factor) for parent lookups. */
    let vlByPath = null;
    let bigRef = null; // the p = 1 sample (same tree as the export geometry)
    if (sampleAt) {
      try {
        const ps = [];
        for (let k = 0; k <= 20; k++) ps.push(k / 20);
        sampleSeries = new Map();
        vlByPath = new Map();
        for (const p of ps) {
          const probe = new Tree(sampleAt(p));
          probe.#generateSkeleton();
          const m = new Map();
          for (const sb of probe.skeleton.branches) {
            if (!byPath.has(sb.path)) continue;
            const attach = sb.sections[0].origin;
            const tip = sb.sections[sb.sections.length - 1].origin;
            const chord = attach.distanceTo(tip);
            let dir = null;
            let wz = 0;
            if (sb.sections.length > 1) {
              const d = new THREE.Vector3().subVectors(
                sb.sections[1].origin,
                sb.sections[0].origin,
              );
              const len = d.length();
              if (len > 1e-9) {
                dir = d.multiplyScalar(1 / len);
                wz = new THREE.Vector3().subVectors(tip, attach).dot(dir);
              }
            }
            m.set(sb.path, {
              attach: attach.clone(),
              dir,
              wz,
              chord,
              baseRad: sb.sections[0].radius,
            });
          }
          sampleSeries.set(p, m);
          if (p >= 1) bigRef = m;
        }
        for (const [pk, m] of sampleSeries) {
          for (const [path, e] of m) {
            const ref = bigRef.get(path);
            if (!ref || ref.chord <= 1e-9) continue;
            let v = vlByPath.get(path);
            if (!v) { v = new Map(); vlByPath.set(path, v); }
            v.set(pk, e.chord / ref.chord);
          }
        }
      } catch (err) {
        // Fall back to the analytic tracks if sampling fails for any reason.
        console.warn('createGrowthExportScene: sampling failed, using analytic tracks', err);
        sampleSeries = null;
        vlByPath = null;
      }
    }

    /** Linear interpolation over a Map(progress → number); 1 fallback. */
    const lerpMap = (v, p) => {
      if (!v || v.size === 0) return 1;
      const keys = [...v.keys()].sort((a, b) => a - b);
      if (p <= keys[0]) return v.get(keys[0]);
      if (p >= keys[keys.length - 1]) return v.get(keys[keys.length - 1]);
      for (let i = 1; i < keys.length; i++) {
        if (p <= keys[i]) {
          const a = keys[i - 1];
          const b = keys[i];
          const f = (p - a) / Math.max(1e-9, b - a);
          return v.get(a) + (v.get(b) - v.get(a)) * f;
        }
      }
      return 1;
    };

    /**
     * Mirrors #growthLevel for a skeleton branch: it becomes visible when its
     * level's birth window opens (≈8% into the window — the length ≥ 0.36
     * bud threshold), staggered per sibling / user branch, and is fully
     * mature when the window ends (stagger no longer matters at the end).
     * Also exposes the window factor as a curve g(p) → {l, r} so the export
     * track can multiply it with the small→big param interpolation.
     * @param {{path: string, level: number, user?: object}} sb
     */
    const growthInfoOf = (sb) => {
      if (isRootBranch(sb)) {
        // No window: constant factor 1 (full length from frame one, like
        // the runtime — #generateRoots never applies #growthLevel).
        return { g: () => ({ l: 1, r: 1 }), born: 0, mature: 0, windowStart: 1 };
      }
      // In fullAtStart mode every branch exists from the first frame; the
      // birth-window factor is therefore always 1 and leaves/branches show
      // immediately at their young size.
      if (fullAtStart) {
        return { g: () => ({ l: 1, r: 1 }), born: 0, mature: 0, windowStart: 0 };
      }
      const w = Tree.growthWindows[Math.min(sb.level, Tree.growthWindows.length - 1)];
      const width = Math.max(1e-6, w.end - w.start);
      let stagger = 0;
      if (sb.user) {
        const ub = sb.user;
        stagger = -0.08 * (ub.t ?? 0.5) - 0.02 * ((ub.id ?? 0) % 4);
      } else {
        // Procedural child: sibling index from the path's trailing number
        // (e.g. "0.3" → 3). Tip continuations ("0.2c") and roots ("0.root0")
        // don't match and keep stagger 0 — they appear with their parent.
        const m = sb.path.match(/\.(\d+)$/);
        if (m) {
          const parentPath = sb.path.slice(0, sb.path.lastIndexOf('.'));
          let count = 1;
          for (const other of this.skeleton.branches) {
            if (other === sb) continue;
            const om = other.path.match(/\.(\d+)$/);
            if (om && other.path.slice(0, other.path.lastIndexOf('.')) === parentPath) {
              count++;
            }
          }
          if (count > 1) stagger = -0.05 * (parseInt(m[1], 10) / (count - 1));
        }
      }
      const g = (p) => {
        // Same math as #growthLevel(level, stagger): mature once the window
        // has ended (stagger delays only the birth), bud at 35% length /
        // 80% radius inside the window, smoothstep between.
        if (p >= w.end) return { l: 1, r: 1 };
        const pp = Math.min(1, Math.max(0, p + stagger));
        const local = (pp - w.start) / width;
        if (local < 0) return { l: 0, r: 0.8 };
        const s = local >= 1 ? 1 : local * local * (3 - 2 * local);
        return { l: 0.35 + 0.65 * s, r: 0.8 + 0.2 * s };
      };
      return {
        g,
        born: Math.min(1, Math.max(0, w.start + 0.08 * width - stagger)),
        mature: Math.min(1, w.end),
        windowStart: w.start,
      };
    };

    /**
     * A branch's ABSOLUTE world-scale target over time, in its own frame:
     *   W(p) = k(p) × g(p)
     * where g is the birth-window factor (growthInfoOf) and k is the
     * small→big parameter interpolation for the branch's level. Branches
     * whose size does NOT come from the interpolated per-level params
     * (explicit length/radius overrides, buttress roots) keep k = 1.
     * @param {{path: string, level: number, user?: object}} sb
     * @param {{g: (p:number)=>{l:number,r:number}}} info
     */
    const absScaleOf = (sb, info) => {
      const ratios = levelRatios[sb.level] ?? { lScale: 1, rScale: 1 };
      const ov = (this.options.branch.overrides && this.options.branch.overrides[sb.path]) || {};
      const root = isRootBranch(sb);
      const lStatic = root || ov.length != null;
      const rStatic = root || (sb.user && (ov.radius != null || ov.radiusAbs != null));
      const l = (p) => {
        const k = lStatic ? 1 : ratios.lScale + (1 - ratios.lScale) * easeP(p);
        return k * info.g(p).l;
      };
      const r = (p) => {
        const k = rStatic ? 1 : ratios.rScale + (1 - ratios.rScale) * easeP(p);
        return k * info.g(p).r;
      };
      return { l, r };
    };

    /**
     * Branch scale track. Two different semantics, matching the runtime
     * generator exactly:
     *  - RADIUS compounds down the hierarchy (the runtime computes a child's
     *    radius as its param × the parent's CURRENT section radius), so the
     *    local r track is simply the branch's own absolute W_r — the GLB
     *    parent chain reproduces the compounding for free.
     *  - LENGTH is ABSOLUTE in the runtime (param × own window, independent
     *    of the parent's length), so the local l track must DIVIDE OUT the
     *    parent's length factor, cancelling the hierarchy's scaling. The
     *    attachment point still rides the parent because it lives in the
     *    parent's local frame — only the child's own geometry is corrected.
     * Keyframes span the whole timeline [born, 1]: through the birth window
     * the window factor dominates, afterwards only the small→big parameter
     * interpolation keeps evolving (the trunk keeps growing until p = 1,
     * exactly like the scene).
     */
    const pushBranchTrack = (node, sb, info, absW, parentAbsW) => {
      const budAtStart = info.windowStart <= 1e-3;
      const times = [];
      const values = [];
      if (!budAtStart && info.born > 1e-4) {
        times.push(0);
        values.push(0, 0, 0);
      }
      const ps = [info.born];
      const wSpan = Math.max(0, info.mature - info.born);
      for (const f of [0.25, 0.5, 0.75, 1]) ps.push(info.born + wSpan * f);
      const tail = Math.max(0, 1 - info.mature);
      for (const f of [0.25, 0.5, 0.75, 1]) ps.push(info.mature + tail * f);
      ps.sort((a, b) => a - b);
      let lastT = -1;
      for (const p of ps) {
        if (p > 1 + 1e-9) break;
        const wr = absW.r(p);
        const wl = absW.l(p);
        const sl = parentAbsW ? wl / Math.max(1e-6, parentAbsW.l(p)) : wl;
        const t = Math.min(1, p) * duration;
        if (times.length && t - lastT < 1e-4) continue;
        lastT = t;
        times.push(t);
        values.push(wr, wr, sl);
      }
      tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.scale', times, values));
    };

    /**
     * Empirical branch tracks baked from the sampled runtime skeletons.
     * For every sample the runtime branch's attach point, mean direction
     * (attach→tip chord) and size factors form a target world matrix
     *   G(p) · diag(vr, vr, vl)
     * which is converted into the parent's ANIMATED local frame and
     * decomposed into position / quaternion / scale keyframes. The
     * quaternion track is what lets mid-growth branches that swing away
     * from their rest direction (small→big angle interpolation, S-curved
     * spines, user-branch chains) still track the scene — a scale-only
     * track stretches along the REST axis and cannot reproduce a swing.
     * Children are converted against the RECOMPOSED matrix (from the
     * decomposed values actually pushed to the tracks), so what they see
     * is exactly what the GLB will apply.
     * @returns {{chain: object, animW: Map<number, THREE.Matrix4>}|null}
     *   chain: world-scale factors for leaf-group compensation;
     *   animW: per-sample animated world matrices for children / leaves.
     */
    const pushMeasuredTracks = (node, sb, idx, parentNode) => {
      if (!sampleSeries) return null;
      const path = sb.path;
      const ref = bigRef.get(path);
      if (!ref) return null;
      const frame = frames[idx];
      const restAttach = sb.sections[0].origin;
      const restTip = sb.sections[sb.sections.length - 1].origin;
      const restChord = restAttach.distanceTo(restTip);
      const restZProj = new THREE.Vector3()
        .subVectors(restTip, restAttach)
        .dot(frame.zAxis);
      // Projection ratio is the accurate metric (it places the tip along
      // the branch axis), but unstable when the rest spine curls past
      // perpendicular — fall back to the chord ratio there.
      const projStable = Math.abs(restZProj) > 0.15 * restChord && restChord > 1e-9;

      const raw = [];
      for (const [p, m] of sampleSeries) {
        const e = m.get(path);
        if (!e) continue;
        let vl;
        if (projStable) {
          vl = e.wz / restZProj;
          if (!Number.isFinite(vl)) vl = e.chord / restChord;
          vl = Math.min(30, Math.max(0.02, vl));
        } else {
          vl = restChord > 1e-9 ? e.chord / restChord : 1;
        }
        raw.push({
          p,
          attach: e.attach,
          dir: e.dir,
          chord: e.chord,
          vr: ref.baseRad > 1e-9 ? e.baseRad / ref.baseRad : 1,
          vl,
        });
      }
      // Zero until the branch actually appears in the runtime tree (a
      // zero-length but non-zero-radius scale would flatten the tube into
      // a visible disc).
      const vis = raw.filter((s) => s.dir && s.chord > 1e-4);
      if (!vis.length) return null;
      const parentAnimW = parentNode && parentNode.animW ? parentNode.animW : null;
      const parentChain = parentNode ? parentNode.chain : null;

      // The parent's animated world matrix at p. When the parent fell back
      // to the analytic tracks — or its baked matrix is momentarily
      // degenerate (a near-zero scale makes the exact inverse explode) —
      // approximate it as its rest world matrix scaled diagonally by the
      // world chain factors.
      const minColNorm = (w) => {
        const e = w.elements;
        const nx = Math.hypot(e[0], e[1], e[2]);
        const ny = Math.hypot(e[4], e[5], e[6]);
        const nz = Math.hypot(e[8], e[9], e[10]);
        return Math.min(nx, ny, nz);
      };
      const parentWorldAt = (p) => {
        if (parentAnimW) {
          // nearest sample (children key at their own sample p's)
          let best = null;
          let bd = Infinity;
          for (const [pk, w] of parentAnimW) {
            const d = Math.abs(pk - p);
            if (d < bd) { bd = d; best = w; }
          }
          if (best && minColNorm(best) > 0.02) return best;
        }
        if (!parentNode) return null;
        const wv = Math.max(1e-6, parentChain ? parentChain.vrAt(p) : 1);
        const wl = Math.max(1e-6, parentChain ? parentChain.vlAt(p) : 1);
        return worldMat[parentNode.idx].clone()
          .multiply(new THREE.Matrix4().makeScale(wv, wv, wl));
      };

      const keys = [];
      for (const s of vis) {
        // Target frame: z along the runtime FIRST-SECTION direction (equals
        // the rest direction at p = 1, so the final pose is the rest pose),
        // radial axes kept as close to the REST radial axes as possible
        // (no twist jumps between samples).
        const zAxis = s.dir.clone();
        const xAxis = frame.xAxis.clone().addScaledVector(zAxis, -frame.xAxis.dot(zAxis));
        if (xAxis.lengthSq() < 1e-8) {
          xAxis.copy(frame.yAxis).addScaledVector(zAxis, -frame.yAxis.dot(zAxis));
        }
        if (xAxis.lengthSq() < 1e-8) {
          xAxis.set(1, 0, 0).addScaledVector(zAxis, -zAxis.x);
        }
        xAxis.normalize();
        const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
        const target = new THREE.Matrix4()
          .makeBasis(xAxis, yAxis, zAxis)
          .setPosition(s.attach)
          .multiply(new THREE.Matrix4().makeScale(s.vr, s.vr, s.vl));
        const M = target;
        const pw = parentWorldAt(s.p);
        if (pw) M.premultiply(pw.clone().invert());
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        M.decompose(pos, quat, scl);
        // Recompose from the DECOMPOSED values — decompose is lossy for
        // sheared matrices, and children must convert against the matrix
        // the GLB will actually apply.
        const W = new THREE.Matrix4().compose(pos, quat, scl);
        if (pw) W.premultiply(pw);
        keys.push({ p: s.p, pos, quat, scl, W });
      }

      // keyframes: hold the first pose before birth (scale 0 hides it).
      const sTimes = [];
      const sValues = [];
      const pTimes = [];
      const pValues = [];
      const qTimes = [];
      const qValues = [];
      const k0 = keys[0];
      if (k0.p > 1e-4) {
        const t0 = k0.p * duration;
        sTimes.push(0, t0);
        sValues.push(0, 0, 0, 0, 0, 0);
        pTimes.push(0, t0);
        pValues.push(k0.pos.x, k0.pos.y, k0.pos.z, k0.pos.x, k0.pos.y, k0.pos.z);
        qTimes.push(0, t0);
        qValues.push(
          k0.quat.x, k0.quat.y, k0.quat.z, k0.quat.w,
          k0.quat.x, k0.quat.y, k0.quat.z, k0.quat.w,
        );
      }
      let lastT = sTimes.length ? sTimes[sTimes.length - 1] : -1;
      for (const k of keys) {
        const t = k.p * duration;
        if (t - lastT < 1e-4) continue;
        lastT = t;
        sTimes.push(t);
        sValues.push(k.scl.x, k.scl.y, k.scl.z);
        pTimes.push(t);
        pValues.push(k.pos.x, k.pos.y, k.pos.z);
        qTimes.push(t);
        qValues.push(k.quat.x, k.quat.y, k.quat.z, k.quat.w);
      }
      tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.scale', sTimes, sValues));
      tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.position', pTimes, pValues));
      tracks.push(new THREE.QuaternionKeyframeTrack(node.uuid + '.quaternion', qTimes, qValues));

      // World-scale chain factors + animated world matrices for children
      // and leaf groups.
      const vrSeries = new Map(vis.map((s) => [s.p, s.vr]));
      const chain = {
        vrAt: (p) => (parentChain ? parentChain.vrAt(p) : 1) * lerpMap(vrSeries, p),
        vlAt: (p) => lerpMap(vlByPath.get(path), p),
      };
      const animW = new Map(keys.map((k) => [k.p, k.W]));
      return { chain, animW };
    };
    /**
     * Leaf-group scale track: the birth window (0 → 1 over the last stretch
     * of the owner branch's window) times an optional per-axis factor that
     * cancels the owner branch's inherited world scaling, so the leaves keep
     * their ABSOLUTE interpolated size (small-tree leaves → big-tree leaves)
     * instead of shrinking with the branch they ride on. Keys extend to
     * p = 1 because the factor keeps evolving after the window closes.
     * @param {THREE.Object3D} node
     * @param {number} bornP
     * @param {number} matureP
     * @param {(p: number) => {x: number, y: number, z: number}} [factor]
     */
    const pushLeafTrack = (node, bornP, matureP, factor) => {
      const born = Math.max(0, bornP);
      const span = Math.max(1e-6, matureP - born);
      const f = typeof factor === 'function'
        ? (p) => factor(p)
        : () => ({ x: 1, y: 1, z: 1 });
      const times = [];
      const values = [];
      if (bornP > 1e-4) {
        times.push(0);
        values.push(0, 0, 0);
      }
      const ps = [];
      for (const x of [0, 0.5, 1]) ps.push(born + span * x);
      if (matureP < 1 - 1e-4) {
        for (const x of [0.25, 0.5, 0.75, 1]) ps.push(matureP + (1 - matureP) * x);
      }
      ps.sort((a, b) => a - b);
      let lastT = -1;
      for (const p of ps) {
        const w = p <= born ? 0 : p >= matureP ? 1 : (p - born) / span;
        const s = w >= 1 ? 1 : 0.2 + 0.8 * (w * w * (3 - 2 * w));
        const fc = f(Math.min(1, Math.max(0, p)));
        const t = p * duration;
        if (times.length && t - lastT < 1e-4) continue;
        lastT = t;
        times.push(t);
        values.push(s * fc.x, s * fc.y, s * fc.z);
      }
      tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.scale', times, values));
    };

    // ---- branch meshes: one node per branch, parented to its skeleton
    // ---- parent, geometry in the branch's own local frame.
    const nodes = [];
    branches.forEach((sb, idx) => {
      const buffers = { verts: [], normals: [], uvs: [], indices: [], branchIndex: [] };
      this.#meshBranch(buffers, sb, idx, 1, 1);
      localizeBuffers(buffers, frames[idx]);
      const mesh = new THREE.Mesh(this.#buildBufferGeometry(buffers), barkMaterial);
      mesh.name = `Branch_${idx}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const pIdx = parentIndex(idx);
      const parentNode = pIdx >= 0 && nodes[pIdx] ? nodes[pIdx] : null;
      const parentObj = parentNode ? parentNode.mesh : rig;
      parentObj.add(mesh);
      // Every node — including the trunk under the rig — gets its local
      // transform from the inverse chain, so its frame (origin + basis) is
      // applied exactly once and children land on their attachment points.
      const parentMat = parentNode ? worldMat[pIdx] : new THREE.Matrix4().identity();
      const local = new THREE.Matrix4().copy(parentMat).invert().multiply(worldMat[idx]);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      local.decompose(pos, quat, scl);
      mesh.position.copy(pos);
      mesh.quaternion.copy(quat);

      const info = growthInfoOf(sb);
      const absW = absScaleOf(sb, info);
      // Prefer the empirically baked tracks (measured attach / direction /
      // length / radius of the runtime tree sampled over the timeline);
      // fall back to the analytic curves only when sampling is unavailable.
      const baked = pushMeasuredTracks(mesh, sb, idx, parentNode);
      if (!baked) pushBranchTrack(mesh, sb, info, absW, parentNode ? parentNode.absW : null);
      // World-scale chain factors for children / leaf groups. Measured nodes
      // carry their sampled factors; analytic fallback nodes approximate the
      // chain with their closed-form absolute factors.
      const chain = baked.chain || (parentNode && parentNode.chain
        ? {
          vrAt: (p) => parentNode.chain.vrAt(p) * absW.r(p),
          vlAt: (p) => parentNode.chain.vlAt(p) * absW.l(p),
        }
        : { vrAt: absW.r, vlAt: absW.l });
      nodes.push({
        mesh, sb, idx, pIdx, born: info.born, mature: info.mature, absW, chain,
        animW: baked.animW || null,
      });
    });

    // ---- sapling leaves: several small rings on the young trunk so t=0
    // ---- already looks like a leafy seedling. The runtime gates terminal
    // ---- branches by level windows, so without these the canopy would be
    // ---- almost bare until the first twigs are born. Multiple rings with
    // ---- enough instances give continuous foliage from the very start.
    const trunkIdx = branches.findIndex((sb) => sb.path === '0');
    if (trunkIdx >= 0 && this.options.leaves) {
      const secs = branches[trunkIdx].sections;
      // Use the small-tree leaf size so the early canopy does not look tiny.
      const leafSize = (this.options.leaves.size ?? 0.5) * leafSizeRatio;
      const buf = { verts: [], normals: [], uvs: [], indices: [] };
      let i0 = 0;
      const rings = [0.22, 0.42, 0.62, 0.82];
      for (let rIdx = 0; rIdx < rings.length; rIdx++) {
        const along = rings[rIdx];
        let A = secs[0];
        let B = secs[secs.length - 1];
        for (let k = 0; k < secs.length - 1; k++) {
          const t0 = secs[k].t ?? k / (secs.length - 1);
          const t1 = secs[k + 1].t ?? (k + 1) / (secs.length - 1);
          if (along >= t0 && along <= t1) { A = secs[k]; B = secs[k + 1]; break; }
        }
        const f01 = Math.min(1, Math.max(0,
          (along - (A.t ?? 0)) / (((B.t ?? 1) - (A.t ?? 0)) || 1e-9)));
        const radius = A.radius + (B.radius - A.radius) * f01;
        const z = A.origin.distanceTo(secs[0].origin)
          + new THREE.Vector3().subVectors(B.origin, A.origin).length() * f01;
        const rRing = Math.max(0.06, radius * 2.0);
        const count = 8;
        for (let i = 0; i < count; i++) {
          const th = (i / count) * Math.PI * 2 + rIdx * 0.7;
          const cx = Math.cos(th) * rRing;
          const cy = Math.sin(th) * rRing;
          const rad = [Math.cos(th), Math.sin(th)];
          const hw = leafSize * 0.5;
          const pts = [
            [cx + rad[0] * hw, cy + rad[1] * hw, z + hw * 0.8],
            [cx - rad[0] * hw, cy - rad[1] * hw, z + hw * 0.8],
            [cx - rad[0] * hw, cy - rad[1] * hw, z - hw * 0.8],
            [cx + rad[0] * hw, cy + rad[1] * hw, z - hw * 0.8],
          ];
          const nx = -rad[1];
          const ny = rad[0];
          for (const [px, py, pz] of pts) {
            buf.verts.push(px, py, pz);
            buf.normals.push(nx, ny, 0);
            buf.uvs.push(0, 0);
          }
          buf.indices.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
          i0 += 4;
        }
      }
      const mesh = new THREE.Mesh(this.#buildBufferGeometry(buf), leafMaterial);
      mesh.name = 'SeedlingLeaves';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      nodes[trunkIdx].mesh.add(mesh);
      // Counter-scale the trunk's radial growth so the rings keep their
      // absolute sapling size and hug the trunk as it thickens. The z axis is
      // left at 1 so the rings ride up automatically as the trunk elongates.
      const trunkChain = nodes[trunkIdx].chain;
      const trunkAnimW = nodes[trunkIdx].animW;
      if (trunkChain || trunkAnimW) {
        const radialAt = (p) => {
          if (trunkAnimW && trunkAnimW.size) {
            let best = null;
            let bd = Infinity;
            for (const [pk, w] of trunkAnimW) {
              const d = Math.abs(pk - p);
              if (d < bd) { bd = d; best = w; }
            }
            if (best) {
              const e = best.elements;
              return Math.hypot(e[0], e[1], e[2]);
            }
          }
          return trunkChain ? trunkChain.vrAt(p) : 1;
        };
        const times = [];
        const values = [];
        for (const p of [0, 0.15, 0.3, 0.5, 0.75, 1]) {
          const invR = 1 / Math.max(0.02, radialAt(p));
          times.push(p * duration);
          values.push(invR, invR, 1);
        }
        tracks.push(new THREE.VectorKeyframeTrack(mesh.uuid + '.scale', times, values));
      }
    }

    // ---- leaf groups: leaves grouped by their nearest branch, anchored at
    // ---- the group's centroid in that branch's frame.
    const leavesLevel = Math.min(
      this.options.leaves.level ?? this.options.branch.levels,
      this.options.branch.levels,
    );
    const candidates = nodes.filter((n) => n.sb.level >= leavesLevel);
    const fallbackCandidates = candidates.length ? candidates : nodes;

    const groupBuffers = new Map(); // branch idx → buffers
    const groupBirth = new Map();   // branch idx → {born, mature, width}
    const groupAnchor = new Map();  // branch idx → {x, y, z, count} (world avg)
    const leaves = this.skeleton.leaves;
    for (let li = 0; li < leaves.length; li++) {
      const leaf = leaves[li];
      const o = leaf.origin;
      let best = null;
      let bestD = Infinity;
      for (const n of fallbackCandidates) {
        const sections = n.sb.sections;
        for (let k = 0; k < sections.length - 1; k++) {
          const a = sections[k].origin;
          const b = sections[k + 1].origin;
          const abx = b.x - a.x;
          const aby = b.y - a.y;
          const abz = b.z - a.z;
          const len2 = abx * abx + aby * aby + abz * abz || 1e-9;
          let alpha = ((o.x - a.x) * abx + (o.y - a.y) * aby + (o.z - a.z) * abz) / len2;
          alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
          const dx = o.x - (a.x + abx * alpha);
          const dy = o.y - (a.y + aby * alpha);
          const dz = o.z - (a.z + abz * alpha);
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
      if (!best) continue;
      const key = best.idx;
      if (!groupBuffers.has(key)) {
        groupBuffers.set(key, { verts: [], normals: [], uvs: [], indices: [] });
        groupBirth.set(key, growthInfoOf(best.sb));
      }
      if (leaf.slab) {
        this.#meshSlab(groupBuffers.get(key), leaf, 1);
      } else {
        this.#meshLeaf(groupBuffers.get(key), leaf, 1, this.options.leaves.billboard);
      }
      const acc = groupAnchor.get(key) || { x: 0, y: 0, z: 0, count: 0 };
      acc.x += o.x;
      acc.y += o.y;
      acc.z += o.z;
      acc.count++;
      groupAnchor.set(key, acc);
    }

    for (const [key, buffers] of groupBuffers) {
      const parentNode = nodes[key];
      const frame = frames[key];
      const acc = groupAnchor.get(key);
      const anchorW = new THREE.Vector3(acc.x / acc.count, acc.y / acc.count, acc.z / acc.count);
      const anchorLocal = toLocal(frame, anchorW.clone());
      localizeBuffers(buffers, { origin: anchorW, R: frame.R, Rt: frame.Rt });
      const mesh = new THREE.Mesh(this.#buildBufferGeometry(buffers), leafMaterial);
      mesh.name = `Leaves_${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parentNode.mesh.add(mesh);
      mesh.position.copy(anchorLocal);

      const { born, mature } = groupBirth.get(key);
      // Leaves appear as soon as the branch itself becomes visible, then
      // grow from a small bud to their full interpolated size. This mirrors
      // the runtime where leaves are present from the start and ramp up.
      // In fullAtStart mode the branch is already visible at t=0, so the
      // leaves are too.
      const leafBorn = fullAtStart ? 0 : born;
      // Cancel the owner branch's inherited world scaling per axis so the
      // leaves keep their ABSOLUTE interpolated size (small → big) instead
      // of shrinking with the branch; kLeaf mirrors GrowthController's
      // leaves.size interpolation over the whole timeline. With baked
      // rotation tracks the owner's animated world matrix (nearest sample)
      // gives the exact per-axis world scale.
      const kLeaf = (p) => leafSizeRatio + (1 - leafSizeRatio) * easeP(p);
      const ownerAnimW = parentNode.animW;
      const leafChain = parentNode.chain || { vrAt: () => 1, vlAt: () => 1 };
      const axisNorm = (p, col) => {
        if (ownerAnimW && ownerAnimW.size) {
          let best = null;
          let bd = Infinity;
          for (const [pk, w] of ownerAnimW) {
            const d = Math.abs(pk - p);
            if (d < bd) { bd = d; best = w; }
          }
          if (best) {
            const e = best.elements;
            const o = col * 4;
            return Math.hypot(e[o], e[o + 1], e[o + 2]);
          }
        }
        return col === 2 ? leafChain.vlAt(p) : leafChain.vrAt(p);
      };
      const leafFactor = (p) => ({
        x: kLeaf(p) / Math.max(0.02, axisNorm(p, 0)),
        y: kLeaf(p) / Math.max(0.02, axisNorm(p, 1)),
        z: kLeaf(p) / Math.max(0.02, axisNorm(p, 2)),
      });
      pushLeafTrack(mesh, leafBorn, mature, sampleSeries ? leafFactor : undefined);
    }

    // ---- optional whole-tree scale animation (sapling scale → 1) ----
    // opts.scaleStart is the small tree's ABSOLUTE scale; the root already
    // carries the big tree's static scale, so animate the RELATIVE ratio
    // (small/big → 1) with the same smoothstep ease the runtime uses.
    // A matching position track lifts the rig so the tree's lowest point
    // (buttress roots, low branches that dip below y=0 at any progress
    // value) stays at world y = 0 throughout — no floating.
    if (
      typeof opts.scaleStart === 'number'
      && opts.scaleStart > 0
      && Math.abs(opts.scaleStart - 1) > 1e-3
    ) {
      const bigScale = (typeof treeScale === 'number' && treeScale > 0) ? treeScale : 1;
      const s0 = Math.max(1e-4, opts.scaleStart / bigScale);
      if (Math.abs(s0 - 1) > 1e-3) {
        const keyframes = [0, 0.25, 0.5, 0.75, 1];
        const times = [];
        const scaleVals = [];
        for (const f of keyframes) {
          const s = s0 + (1 - s0) * easeP(f);
          times.push(f * duration);
          scaleVals.push(s, s, s);
        }
        tracks.push(new THREE.VectorKeyframeTrack(rig.uuid + '.scale', times, scaleVals));

        // Evaluate the animation (with all tracks so far, including the
        // per-branch empirical baking) at each keyframe to measure the ACTUAL
        // world-space lowest point. The ground offset must cover the worst
        // case across the whole timeline, not just the rest pose.
        const tempClip = new THREE.AnimationClip('_groundProbe', duration, tracks);
        const tempMixer = new THREE.AnimationMixer(scene);
        const tempAction = tempMixer.clipAction(tempClip);
        tempAction.play();
        const posVals = [];
        let needsPosTrack = false;
        for (let i = 0; i < keyframes.length; i++) {
          tempMixer.setTime(keyframes[i] * duration);
          scene.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(root);
          const offset = Math.max(0, -box.min.y);
          if (offset > 0.01) needsPosTrack = true;
          posVals.push(0, offset, 0);
        }
        // Restore rest pose so the caller sees a clean scene.
        tempMixer.uncacheAction(tempAction);
        rig.position.set(0, 0, 0);
        rig.scale.set(1, 1, 1);
        scene.updateMatrixWorld(true);

        if (needsPosTrack) {
          tracks.push(new THREE.VectorKeyframeTrack(rig.uuid + '.position', times, posVals));
        }
      }
    }

    const clip = new THREE.AnimationClip('TreeGrowth', duration, tracks);
    return { scene, clip, duration };
  }

  /**
   * Builds a crossfade export scene for structurally different small/big
   * trees. Two complete tree models are generated independently; the small
   * one stays visible at the start while the big one scales up from the
   * small height, then the small one shrinks away so the clip ends on the
   * big tree alone.
   */
  #createDualTreeExportScene(opts) {
    const duration = opts.duration ?? 12;
    const smallOpts = opts.smallOptions;
    const bigOpts = this.options;

    const smallTree = new Tree(smallOpts);
    smallTree.generate();
    const bigTree = new Tree(bigOpts);
    bigTree.generate();

    const scene = new THREE.Scene();
    scene.name = 'TreeGrowth';

    const root = new THREE.Group();
    root.name = 'Tree';
    scene.add(root);

    const easeP = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

    const addTree = (tree, name) => {
      const group = new THREE.Group();
      group.name = name;
      const box = new THREE.Box3().setFromObject(tree);
      const groundOffset = Math.max(0, -box.min.y);
      if (groundOffset > 0.01) group.position.y = groundOffset;
      // Rename the inner tree so its name does not collide with the group
      // name; GLTFExporter resolves animation tracks by node name.
      tree.name = `${name}Geo`;
      group.add(tree);
      root.add(group);
      return { group, box, groundOffset, height: box.max.y - box.min.y };
    };

    const smallData = addTree(smallTree, 'SmallTree');
    const bigData = addTree(bigTree, 'BigTree');

    // The big tree starts nearly invisible so the first frame reads as the
    // real small tree alone. It then grows to full size while the small tree
    // shrinks away in the second half of the clip.
    const bigScaleStart = 0.02;
    const bigScaleEnd = 1;

    const smallTimes = [];
    const smallScales = [];
    const bigTimes = [];
    const bigScales = [];
    for (const f of [0, 0.15, 0.3, 0.5, 0.75, 1]) {
      const t = f * duration;
      const e = easeP(f);
      smallTimes.push(t);
      // Small tree keeps its natural size for the first ~50%, then shrinks
      // to nothing so the big tree can take over without overlap.
      const smallS = f < 0.5 ? 1 : 1 - (f - 0.5) / 0.5;
      smallScales.push(smallS, smallS, smallS);

      bigTimes.push(t);
      const bigS = bigScaleStart + (bigScaleEnd - bigScaleStart) * e;
      bigScales.push(bigS, bigS, bigS);
    }

    const tracks = [
      new THREE.VectorKeyframeTrack('SmallTree.scale', smallTimes, smallScales),
      new THREE.VectorKeyframeTrack('BigTree.scale', bigTimes, bigScales),
    ];

    const clip = new THREE.AnimationClip('TreeGrowth', duration, tracks);
    return { scene, clip, duration };
  }

  /**
   * Tears down any LOD state and restores the flat branches/leaves meshes
   * as direct children, so generate() behaves as if LODs never existed.
   */
  #clearLOD() {
    if (!this.lod) return;

    this.lod.levels.forEach((level) => {
      for (const mesh of level.object.children) {
        // One level reuses branchesMesh/leavesMesh; their geometry and the
        // shared materials are disposed by whichever generate path runs next.
        if (mesh === this.branchesMesh || mesh === this.leavesMesh) continue;
        mesh.geometry.dispose();
      }
    });

    this.remove(this.lod);
    this.lod = null;
    this.add(this.branchesMesh, this.leavesMesh);
  }

  /**
   * Grows the tree skeleton: the section frames of every branch and the
   * placement of every leaf. All RNG consumption happens here, so any
   * number of meshing passes can run against one skeleton without changing
   * the tree's shape.
   */
  #generateSkeleton() {
    this.skeleton = {
      branches: [],
      leaves: [],
    };

    this.rng = new RNG(this.options.seed);
    this.trunkLength = 1;

    const usePerBranch = this.options.rngMode === 'perBranch';
    const trunkRng = usePerBranch ? this.#makeRng('0') : null;
    const trunkG = this.#growthLevel(0);

    // Create the trunk of the tree first
    this.branchQueue.push(
      new Branch(
        new THREE.Vector3(),
        new THREE.Euler(),
        this.options.branch.length[0] * (trunkG?.length ?? 1),
        this.options.branch.radius[0] * (trunkG?.radius ?? 1),
        0,
        this.options.branch.sections[0],
        this.options.branch.segments[0],
        '0',
        trunkRng,
      ),
    );

    while (this.branchQueue.length > 0) {
      const branch = this.branchQueue.shift();
      this.#growBranch(branch);
    }

    // Stage F: user-placed branches grow AFTER the procedural tree, each
    // from its own RNG stream, so they never shift the main tree's shape.
    this.#growUserBranches();
  }

  /**
   * Async, chunked variant of {@link #generateSkeleton}. Grows the tree one
   * branch at a time but yields to the browser every CHUNK branches so the
   * main thread stays responsive on large trees. Produces the same skeleton.
   * @returns {Promise<void>}
   */
  async #generateSkeletonAsync() {
    this.skeleton = {
      branches: [],
      leaves: [],
    };

    this.rng = new RNG(this.options.seed);
    this.trunkLength = 1;

    const usePerBranch = this.options.rngMode === 'perBranch';
    const trunkRng = usePerBranch ? this.#makeRng('0') : null;
    const trunkG = this.#growthLevel(0);

    // Create the trunk of the tree first
    this.branchQueue.push(
      new Branch(
        new THREE.Vector3(),
        new THREE.Euler(),
        this.options.branch.length[0] * (trunkG?.length ?? 1),
        this.options.branch.radius[0] * (trunkG?.radius ?? 1),
        0,
        this.options.branch.sections[0],
        this.options.branch.segments[0],
        '0',
        trunkRng,
      ),
    );

    let processed = 0;
    while (this.branchQueue.length > 0) {
      const branch = this.branchQueue.shift();
      this.#growBranch(branch);
      // Hand control back to the browser every 64 branches so the UI can
      // paint, the camera can keep orbiting, and inputs don't pile up.
      if ((++processed & 63) === 0) await yieldToBrowser();
    }

    // Stage F: user-placed branches grow AFTER the procedural tree, each
    // from its own RNG stream, so they never shift the main tree's shape.
    await this.#growUserBranchesAsync();
  }

  // --------------------------------------------------------------------------
  // Per-branch addressing & RNG
  // --------------------------------------------------------------------------

  /** Stable 32-bit hash of a branch path string (FNV-1a). */
  #hashPath(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** Builds a deterministic RNG for a branch path + global seed. */
  #makeRng(path) {
    return new RNG((this.#hashPath(path) ^ (this.options.seed >>> 0)) >>> 0);
  }

  /** Deterministic [-1,1] pseudo-noise for trunk surface, keyed by path+section. */
  #trunkNoise(seed, i) {
    let h = (this.#hashPath(seed) ^ Math.imul(i + 1, 2654435761)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return (h / 4294967295) * 2 - 1;
  }

  /** Shortest absolute angular distance between two angles (radians). */
  #angleDelta(a, b) {
    let d = (((a - b) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    return Math.abs(d);
  }

  /** Returns the override object for a branch, or null. */
  #ov(branch) {
    const ov = this.options.branch.overrides;
    return (ov && ov[branch.path]) || null;
  }

  /** Resolves a single branch parameter, preferring its override. */
  #branchParam(branch, key, levelDefault) {
    const o = this.#ov(branch);
    return o && o[key] !== undefined ? o[key] : levelDefault;
  }

  /** Number of children a branch spawns, honoring its override. */
  #branchChildren(branch) {
    return this.#branchParam(branch, 'children', this.options.branch.children[branch.level]);
  }

  // --------------------------------------------------------------------------
  // Growth animation (sapling → full tree)
  // --------------------------------------------------------------------------

  /**
   * Growth state for a branch level at the current growth progress. Returns
   * null when growth is disabled — the fast path so normal generation costs
   * nothing extra. `stagger` shifts the level's window for a single branch
   * (e.g. user branches or siblings appear a beat later), in the SAME 0..1
   * progress units.
   * @param {number} level
   * @param {number} [stagger=0] signed progress offset for per-branch stagger
   * @returns {{length: number, radius: number}|null}
   */
  #growthLevel(level, stagger = 0) {
    const g = this.options.growth;
    if (!g || !g.enabled) return null;
    const w = Tree.growthWindows[Math.min(level, Tree.growthWindows.length - 1)];
    const pRaw = Math.min(1, Math.max(0, g.progress ?? 1));
    // Fully mature once the level's window has ended. Stagger shifts only the
    // BIRTH inside the window — at the end of the timeline every branch must
    // be full size, or p=1 would never equal the big-tree baseline.
    if (pRaw >= w.end) return { length: 1, radius: 1 };
    const p = Math.min(1, Math.max(0, pRaw + stagger));
    const local = (p - w.start) / Math.max(1e-6, w.end - w.start);
    if (local < 0) {
      // Window not entered yet: not born. The trunk's window starts at 0 so
      // it is always "born" (the sapling is a trunk) — handled below.
      return { length: 0, radius: 0.8 };
    }
    const s = local >= 1 ? 1 : local * local * (3 - 2 * local);
    return {
      // A just-born branch is already a visible bud (35% of its target
      // length) that stretches out to full size — never a degenerate stub.
      length: 0.35 + 0.65 * s,
      // Radius lags length so young branches read as thin new growth.
      radius: 0.8 + 0.2 * s,
    };
  }

  /**
   * Number of children a branch should spawn at the current growth progress.
   * Ramps `base` from 0 up to `base` inside the CHILD level's birth window,
   * so an entire level of branches pops in gradually instead of all at once.
   * @param {number} childLevel
   * @param {number} base
   */
  #growthChildren(childLevel, base) {
    const g = this.#growthLevel(childLevel);
    if (!g) return base;
    return Math.max(0, Math.round(base * (g.length - 0.35) / 0.65));
  }

  /**
   * Per-child growth stagger (in progress units, negative = later). Children
   * further up the parent (larger i) are "newer" growth and appear a beat
   * later, so a level of branches cascades up the trunk instead of popping
   * in all at once.
   * @param {number} i child index within its parent
   * @param {number} count total children
   */
  #growthStagger(i, count) {
    return count > 1 ? -0.05 * (i / (count - 1)) : 0;
  }

  /**
   * Deepest branch level whose birth window has started at the current
   * progress. Used to decide which level is the "terminal" (leaf-bearing)
   * level: a young tree carries leaves on the trunk / early branches, so the
   * canopy is never bare.
   */
  #grownMaxLevel() {
    const p = Math.min(1, Math.max(0, this.options.growth?.progress ?? 1));
    let max = 0;
    for (let i = 0; i < Tree.growthWindows.length; i++) {
      const w = Tree.growthWindows[i];
      // A level only counts as "growing" once branches actually exist on it:
      // the skip threshold (length >= 0.36) is crossed ~8% into the window.
      // Using the raw window start would pick levels whose branches are all
      // still skipped, leaving the canopy bare mid-growth.
      if (p >= w.start + 0.08 * (w.end - w.start)) max = i;
    }
    return max;
  }

  /**
   * Adds (or replaces) a single override key for a branch path.
   * @param {string} path
   * @param {string} key
   * @param {*} value
   */
  setBranchOverride(path, key, value) {
    if (!this.options.branch.overrides) this.options.branch.overrides = {};
    if (!this.options.branch.overrides[path]) this.options.branch.overrides[path] = {};
    this.options.branch.overrides[path][key] = value;
  }

  /**
   * Removes a single override key (and the whole entry if it becomes empty).
   * @param {string} path
   * @param {string} key
   */
  clearBranchOverride(path, key) {
    const ov = this.options.branch.overrides?.[path];
    if (!ov) return;
    delete ov[key];
    if (Object.keys(ov).length === 0) delete this.options.branch.overrides[path];
  }

  /**
   * Snapshot of a branch's resolved parameters for the editor UI. Returns
   * null if the index is out of range.
   * @param {number} index
   */
  getBranchInfo(index) {
    const sb = this.skeleton?.branches?.[index];
    if (!sb) return null;
    const b = this.options.branch;
    const lvl = sb.level;
    const ov = (b.overrides && b.overrides[sb.path]) || {};
    return {
      index,
      path: sb.path,
      level: lvl,
      length: ov.length ?? b.length[lvl],
      radius: ov.radius ?? b.radius[lvl],
      angle: ov.angle ?? b.angle[lvl],
      children: ov.children ?? b.children[lvl],
      gnarliness: ov.gnarliness ?? b.gnarliness[lvl],
      taper: ov.taper ?? b.taper[lvl],
      twist: ov.twist ?? b.twist[lvl],
      sections: ov.sections ?? b.sections[lvl],
      segments: ov.segments ?? b.segments[lvl],
      start: ov.start ?? b.start[lvl],
      curve: ov.curve ?? null,
      // Stage F: user-branch descriptor (null for procedural branches).
      user: sb.user || null,
    };
  }

  /**
   * Highlights a branch by re-meshing only it into the selection overlay.
   * Pass null to clear.
   * @param {number|null} index
   */
  setSelectedBranch(index) {
    this.selectedBranchIndex = index;
    if (index == null || !this.skeleton?.branches?.[index]) {
      this.selectionMesh.visible = false;
      return;
    }
    const sb = this.skeleton.branches[index];
    const buffers = { verts: [], normals: [], uvs: [], indices: [], branchIndex: [] };
    this.#meshBranch(buffers, sb, index, 1, 1);
    this.selectionMesh.geometry.dispose();
    this.selectionMesh.geometry = this.#buildBufferGeometry(buffers);
    this.selectionMesh.visible = true;
  }

  /**
   * Meshes the current skeleton into geometry buffers at the given detail.
   * Consumes no RNG, so it can run repeatedly with different detail specs.
   * @param {LODDetail} detail
   */
  /**
   * Applies trunk sculpt + global pose to a LOCAL section orientation and
   * returns the posed orientation WITHOUT mutating the local one. This keeps
   * the pose from double-accumulating across sections: each section's final
   * direction is Global(y) * local, recomputed from the (still-local)
   * sectionOrientation on every iteration.
   * @param {THREE.Euler} localEuler local, un-posed orientation
   * @param {number} y world height of this section
   * @param {number} t normalized height 0..1
   * @param {boolean} useTrunk whether this branch is the trunk (level 0)
   * @param {object} trunkOpt this.options.trunk
   * @param {object} gOpt this.options.global
   * @returns {THREE.Euler}
   */
  #applyPose(localEuler, y, t, useTrunk, trunkOpt, gOpt) {
    let e = new THREE.Euler().copy(localEuler);

    // Stage A: twist the trunk about the vertical axis across its height.
    if (useTrunk && trunkOpt.twist) {
      e = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion().setFromEuler(e).premultiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), trunkOpt.twist * t)));
    }

    // Stage E: global pose (lean / twist / asymmetry), scaled by world height.
    if (gOpt && gOpt.enabled) {
      const qG = new THREE.Quaternion();
      if (gOpt.twist) {
        qG.multiply(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0), gOpt.twist * y));
      }
      if (gOpt.lean && (gOpt.lean.x || gOpt.lean.z)) {
        // lean.x tilts toward +X (rotate about Z), lean.z toward +Z (rotate about X)
        qG.multiply(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1), gOpt.lean.x * y));
        qG.multiply(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0), -gOpt.lean.z * y));
      }
      if (!qG.equals(new THREE.Quaternion())) {
        e = new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion().setFromEuler(e).premultiply(qG));
      }
      // Asymmetry: a constant directional bias (like a prevailing wind)
      // bending growth toward asymDir, stronger higher up.
      if (gOpt.asymmetry && (gOpt.asymmetry.x || gOpt.asymmetry.z)) {
        const asymDir = new THREE.Vector3(gOpt.asymmetry.x, 0, gOpt.asymmetry.z).normalize();
        const asymAngle = 0.03 * y;
        const up = new THREE.Vector3(0, 1, 0).applyEuler(e);
        const axis = new THREE.Vector3().crossVectors(up, asymDir);
        const sinFull = axis.length();
        if (sinFull > 1e-6) {
          axis.divideScalar(sinFull);
          const full = Math.atan2(sinFull, up.dot(asymDir));
          const clamped = Math.max(-full, Math.min(full, asymAngle));
          e = new THREE.Euler().setFromQuaternion(
            new THREE.Quaternion().setFromEuler(e).premultiply(
              new THREE.Quaternion().setFromAxisAngle(axis, clamped)));
        }
      }
    }
    return e;
  }

  #meshSkeleton(detail = {}) {
    const sectionStride = Math.max(1, Math.floor(detail.sectionStride ?? 1));
    const segmentFactor = detail.segmentFactor ?? 1;
    const leafStride = Math.max(1, Math.floor(detail.leafStride ?? 1));
    const leafScale = detail.leafScale ?? 1;
    const billboard = detail.billboard ?? this.options.leaves.billboard;

    const branches = {
      verts: [],
      normals: [],
      uvs: [],
      indices: [],
      branchIndex: [],
    };

    const leaves = {
      verts: [],
      normals: [],
      indices: [],
      uvs: [],
    };

    this.skeleton.branches.forEach((skeletonBranch, idx) => {
      this.#meshBranch(branches, skeletonBranch, idx, sectionStride, segmentFactor);
    });

    for (let i = 0; i < this.skeleton.leaves.length; i += leafStride) {
      const leaf = this.skeleton.leaves[i];
      if (leaf.slab) {
        this.#meshSlab(leaves, leaf, leafScale);
      } else {
        this.#meshLeaf(leaves, leaf, leafScale, billboard);
      }
    }

    return { branches, leaves };
  }

  /**
   * Async, chunked variant of {@link #meshSkeleton}. Pushes vertices for one
   * branch at a time but yields to the browser every CHUNK branches (and
   * again across the leaf loop) so meshing a dense canopy doesn't block the
   * main thread. Returns the same buffers shape as #meshSkeleton.
   * @param {LODDetail} detail
   * @returns {Promise<{ branches: object, leaves: object }>}
   */
  async #meshSkeletonAsync(detail = {}) {
    const sectionStride = Math.max(1, Math.floor(detail.sectionStride ?? 1));
    const segmentFactor = detail.segmentFactor ?? 1;
    const leafStride = Math.max(1, Math.floor(detail.leafStride ?? 1));
    const leafScale = detail.leafScale ?? 1;
    const billboard = detail.billboard ?? this.options.leaves.billboard;

    const branches = {
      verts: [],
      normals: [],
      uvs: [],
      indices: [],
      branchIndex: [],
    };

    const leaves = {
      verts: [],
      normals: [],
      indices: [],
      uvs: [],
    };

    let i = 0;
    for (const skeletonBranch of this.skeleton.branches) {
      this.#meshBranch(branches, skeletonBranch, i, sectionStride, segmentFactor);
      if ((++i & 63) === 0) await yieldToBrowser();
    }

    for (let j = 0; j < this.skeleton.leaves.length; j += leafStride) {
      const leaf = this.skeleton.leaves[j];
      if (leaf.slab) {
        this.#meshSlab(leaves, leaf, leafScale);
      } else {
        this.#meshLeaf(leaves, leaf, leafScale, billboard);
      }
      if ((j & 255) === 0) await yieldToBrowser();
    }

    return { branches, leaves };
  }

  /**
   * Grows a branch's skeleton, queueing child branches and recording leaf
   * placements. Consumes RNG in the exact order of the original interleaved
   * generator so seeds keep producing identical trees.
   * @param {Branch} branch
   * @returns
   */
  #growBranch(branch) {
    let sectionOrientation = branch.orientation.clone();
    let sectionOrigin = branch.origin.clone();
    let sectionLength =
      branch.length /
      branch.sectionCount /
      (this.options.type === TreeType.Deciduous ? this.options.branch.levels - 1 : 1);

    // This information is used for generating child branches after the branch
    // geometry has been constructed
    let sections = [];

    // RNG stream for this branch: its own (perBranch) or the shared tree
    // stream (legacy). Using a local keeps the consumption order identical
    // in both modes, so trees stay seed-exact in 'shared'. User-placed
    // branches (Stage F) always use their own stream regardless of mode.
    const rng = (branch.forceOwnRng && branch.rng)
      ? branch.rng
      : (this.options.rngMode === 'perBranch' ? branch.rng : this.rng);

    // Stage A — trunk sculpting (level-0 branches only). Stage E — global
    // pose (whole tree). Read once so the section loop below can apply them.
    const trunkOpt = this.options.trunk;
    const useTrunk = !!(trunkOpt && trunkOpt.enabled && branch.level === 0);
    const gOpt = this.options.global;

    // Stage B: buttress roots (板根/外露根系). Gated by the trunk's own
    // sub-enabled flag so stage A alone doesn't pull in stage B.
    const butt = (useTrunk && trunkOpt.buttress && trunkOpt.buttress.enabled)
      ? trunkOpt.buttress
      : null;

    // Stage D: deadwood (hollow/cracks on trunk, dead branches on children).
    // Hollows/cracks are trunk-only; deadBranchChance is read in
    // generateChildBranches via a dedicated RNG (never perturbs the main stream).
    const dw = (useTrunk && trunkOpt.deadwood && trunkOpt.deadwood.enabled)
      ? trunkOpt.deadwood
      : null;

    const taper = this.#branchParam(branch, 'taper', this.options.branch.taper[branch.level]);
    const twist = this.#branchParam(branch, 'twist', this.options.branch.twist[branch.level]);
    const ovForce = this.#ov(branch)?.force;
    const forceDir = ovForce?.direction ?? this.options.branch.force.direction;
    const forceStrength = ovForce?.strength ?? this.options.branch.force.strength;

    const curve = this.#ov(branch)?.curve;
    const curveWidth = 1.5 / Math.max(1, branch.sectionCount);

    for (let i = 0; i <= branch.sectionCount; i++) {
      let sectionRadius = branch.radius;

      // If final section of final level, set radius to effecively zero
      if (
        i === branch.sectionCount &&
        branch.level === this.options.branch.levels
      ) {
        sectionRadius = 0.001;
      } else if (this.options.type === TreeType.Deciduous) {
        sectionRadius *=
          1 - taper * (i / branch.sectionCount);
      } else if (this.options.type === TreeType.Evergreen) {
        // Evergreens do not have a terminal branch so they have a taper of 1
        sectionRadius *= 1 - (i / branch.sectionCount);
      }

      // Stage A: sculpt the trunk radius (level 0 only). Bottom swell fades
      // from bottomSwell at the base to 1 by swellHeight; surface noise adds
      // vertical furrows/bumps without consuming the RNG stream.
      if (useTrunk) {
        const tT = i / branch.sectionCount;
        let scale = 1;
        if (trunkOpt.bottomSwell !== 1 && trunkOpt.swellHeight > 0) {
          const s = Math.min(1, tT / trunkOpt.swellHeight);
          scale *= 1 + (trunkOpt.bottomSwell - 1) * (1 - s);
        }
        if (trunkOpt.noise > 0) {
          const n = this.#trunkNoise(branch.path, i) * trunkOpt.noise;
          scale *= 1 + n * 0.12;
        }
        sectionRadius *= scale;
      }

      // Stage D: dead branches are thinner (emaciated twig look)
      if (branch.dead) {
        sectionRadius *= 0.6;
      }

      // Apply trunk sculpt + global pose to the *displayed* section only.
      // sectionOrientation stays the local (un-posed) orientation so the
      // per-section perturbation below never double-counts the pose.
      const tNorm = i / branch.sectionCount;
      const sectionPose = this.#applyPose(sectionOrientation, sectionOrigin.y, tNorm, useTrunk, trunkOpt, gOpt);

      // Use this information later on when generating child branches
      sections.push({
        origin: sectionOrigin.clone(),
        orientation: sectionPose.clone(),
        radius: sectionRadius,
        // Normalized height (0..1) within this branch, used by stage B buttress
        // flutes to fade the ridges out with height (kept on every section so
        // meshing stays LOD-safe regardless of how many rings are sampled).
        t: tNorm,
      });

      sectionOrigin.add(
        new THREE.Vector3(0, sectionLength, 0).applyEuler(sectionPose),
      );

      // Stage A: lateral bow of the trunk — a smooth bump centered at
      // bowHeight, displaced along bowDirection. Added as a per-section
      // increment so the offset accumulates to bow*bump(t).
      if (useTrunk && trunkOpt.bow) {
        const tT = i / branch.sectionCount;
        const bump = Math.exp(-Math.pow((tT - trunkOpt.bowHeight) / 0.25, 2));
        const dt = 1 / branch.sectionCount;
        const disp = trunkOpt.bow * bump * dt;
        sectionOrigin.x += Math.cos(trunkOpt.bowDirection) * disp;
        sectionOrigin.z += Math.sin(trunkOpt.bowDirection) * disp;
      }

      // Perturb the orientation of the next section randomly. The higher the
      // gnarliness, the larger potential perturbation
      const gnarliness =
        Math.max(1, 1 / Math.sqrt(sectionRadius)) *
        this.#branchParam(branch, 'gnarliness', this.options.branch.gnarliness[branch.level]) *
        (branch.dead ? 2 : 1);

      sectionOrientation.x += rng.random(gnarliness, -gnarliness);
      sectionOrientation.z += rng.random(gnarliness, -gnarliness);

      // Deterministic curve control points (override-only). Each control
      // point bends the section toward its direction, weighted by a smooth
      // kernel centered on its t position. This gives movable, editable bend
      // points instead of the single random gnarliness drift.
      if (curve && curve.length) {
        const t = i / branch.sectionCount;
        for (const cp of curve) {
          const w = Math.exp(-Math.pow((t - (cp.t ?? 0)) / curveWidth, 2));
          if (w < 1e-3) continue;
          const d = cp.dir || { x: 0, y: 0, z: 0 };
          const s = (cp.strength ?? 0.5) * w;
          sectionOrientation.x += (d.x || 0) * s;
          sectionOrientation.z += (d.z || 0) * s;
          sectionOrientation.y += (d.y || 0) * s;
        }
      }

      // Apply growth force to the branch
      const qSection = new THREE.Quaternion().setFromEuler(sectionOrientation);

      const qTwist = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        twist,
      );

      qSection.multiply(qTwist);

      // Rotate the section's growth direction toward force.direction (positive
      // strength) or away from it (negative). The (sectionUp × target) axis
      // makes force.direction behave as a real world axis: when sectionUp is
      // already aligned with target the rotation is zero, so a vertical trunk
      // with force=(0,1,0) doesn't get gnarliness drift amplified — the old
      // slerp form was degenerate at qForce=identity and pushed branches in
      // whatever random direction the section had drifted.
      const sectionUp = new THREE.Vector3(0, 1, 0).applyQuaternion(qSection);
      const target = new THREE.Vector3()
        .copy(forceDir)
        .normalize();
      const axis = new THREE.Vector3().crossVectors(sectionUp, target);
      const sinFull = axis.length();
      if (sinFull > 1e-6) {
        axis.divideScalar(sinFull);
        const fullAngle = Math.atan2(sinFull, sectionUp.dot(target));
        const step = forceStrength / sectionRadius;
        const clamped = Math.max(-fullAngle, Math.min(fullAngle, step));
        qSection.premultiply(
          new THREE.Quaternion().setFromAxisAngle(axis, clamped),
        );
      }

      // Apply trellis force if enabled
      if (this.options.trellis.enabled) {
        const trellisResult = this.calculateTrellisForce(sectionOrigin, sectionRadius);
        if (trellisResult) {
          const qTrellis = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            trellisResult.direction,
          );
          qSection.rotateTowards(qTrellis, trellisResult.strength);
        }
      }

      sectionOrientation.setFromQuaternion(qSection);
    }

    // Length of this branch (used for trunk reference + leaf density).
    const branchLength = sections[sections.length - 1].origin.distanceTo(sections[0].origin);
    if (branch.path === '0' && branchLength > 0) {
      this.trunkLength = branchLength;
    }

    this.skeleton.branches.push({
      sections,
      segmentCount: branch.segmentCount,
      baseRadius: branch.radius,
      path: branch.path,
      level: branch.level,
      length: branchLength,
      // Stage B: carry the buttress flute parameters so #meshBranch can
      // modulate each vertex's radius by angle (LOD-safe). Null for every
      // non-trunk branch.
      buttress: butt
        ? { flutes: butt.flutes, strength: butt.strength, phase: butt.phase, height: butt.height }
        : null,
      // Stage D: carry deadwood params so #meshBranch can carve hollows/cracks
      // (LOD-safe, like buttress). Null for non-trunk branches.
      deadwood: dw ? {
        hollowStrength: dw.hollowStrength, hollowHeight: dw.hollowHeight,
        hollowWidth: dw.hollowWidth, hollowPhase: dw.hollowPhase,
        crackCount: dw.crackCount, crackDepth: dw.crackDepth,
        crackWidth: dw.crackWidth, crackPhase: dw.crackPhase,
      } : null,
      // Stage F: the user-branch descriptor this skeleton branch was grown
      // from (null for every procedural branch). Used by the editor UI and
      // by move/remove APIs to address it.
      user: branch.user || null,
    });

    // Stage B: sprout exposed root fingers from the trunk base. Runs only for
    // the trunk and only when roots > 0. Uses a dedicated RNG so it never
    // perturbs the main generation stream.
    if (butt && butt.roots > 0) {
      this.#generateRoots(sections, butt, branch.path);
    }

    // Deciduous trees have a terminal branch that grows out of the
    // end of the parent branch. Dead branches don't grow terminal branches.
    if (this.options.type === 'deciduous' && !branch.dead) {
      const lastSection = sections[sections.length - 1];
      const tipG = this.#growthLevel(branch.level + 1);

      if (branch.level < this.options.branch.levels) {
        // Growth: the tip (a level+1 branch) does not exist until its level's
        // birth window opens — the parent simply ends there, like a real
        // young twig.
        if (!tipG || tipG.length >= 0.36) {
          const tipPath = branch.path + 'c';
          const tipOv = (this.options.branch.overrides && this.options.branch.overrides[tipPath]) || {};
          const tipLength = (tipOv.length ?? this.options.branch.length[branch.level + 1])
            * (tipG?.length ?? 1);
          const tipSections = tipOv.sections ?? branch.sectionCount;
          const tipSegments = tipOv.segments ?? branch.segmentCount;
          const tipRng = this.options.rngMode === 'perBranch' ? this.#makeRng(tipPath) : null;
          this.branchQueue.push(
            new Branch(
              lastSection.origin,
              lastSection.orientation,
              tipLength,
              lastSection.radius * (tipG?.radius ?? 1),
              branch.level + 1,
              tipSections,
              tipSegments,
              tipPath,
              tipRng,
            ),
          );
        }
      } else {
        this.#recordLeaf(lastSection.origin, lastSection.orientation, rng,
          this.#ov(branch)?.leafScale ?? 1);
      }
    }

    // Dead branches: bare snapped twig — no children, no leaves.
    if (branch.dead) {
      return;
    }

    // If we are on the last branch level, generate leaves. During growth the
    // "terminal" level is the deepest level that has started growing, so a
    // young tree carries leaves on the trunk / early branches — the canopy
    // is never bare.
    const growthActive = !!(this.options.growth && this.options.growth.enabled);
    const leavesLevel = growthActive
      ? Math.min(this.#grownMaxLevel(), this.options.branch.levels)
      : Math.min(
        this.options.leaves.level ?? this.options.branch.levels,
        this.options.branch.levels,
      );
    const branchG = growthActive ? this.#growthLevel(branch.level) : null;
    const leafGrowth = branchG?.length ?? 1;

    if (branch.level < this.options.branch.levels) {
      this.generateChildBranches(
        growthActive
          ? this.#growthChildren(branch.level + 1, this.#branchChildren(branch))
          : this.#branchChildren(branch),
        branch.level + 1,
        sections,
        rng,
        branch.path,
      );
      if (branch.level >= leavesLevel) {
        this.generateLeaves(sections, rng, branchLength,
          this.#ov(branch)?.leafScale ?? 1, leafGrowth);
      }
    } else {
      this.generateLeaves(sections, rng, branchLength,
        this.#ov(branch)?.leafScale ?? 1, leafGrowth);
    }
  }

  /**
   * Generate branches from a parent branch
   * @param {number} count The number of child branches to generate
   * @param {number} level The level of the child branches
   * @param {{
   *  origin: THREE.Vector3,
   *  orientation: THREE.Euler,
   *  radius: number
   * }[]} sections The parent branch's sections
   * @param {RNG} parentRng The RNG stream driving this generation
   * @param {string} parentPath Stable path of the parent branch
   * @returns
   */
  generateChildBranches(count, level, sections, parentRng, parentPath) {
    const usePerBranch = this.options.rngMode === 'perBranch';
    const startMin = this.options.branch.start[level];
    const heightStep = (1.0 - startMin) / count;

    // In shared mode, shuffle once on the shared stream (legacy order). In
    // perBranch mode each child draws from its own stream so sibling
    // placement is independent and editing one never shifts another.
    const angleSlots = usePerBranch
      ? null
      : this.shuffledIndices(count, parentRng);

    for (let i = 0; i < count; i++) {
      const childPath = parentPath + '.' + i;
      const childOv = (this.options.branch.overrides && this.options.branch.overrides[childPath]) || {};
      const childRng = usePerBranch ? this.#makeRng(childPath) : parentRng;

      // Stratified sampling along the parent's length: jitter within slot [i, i+1]
      // so children are spread evenly but not perfectly periodic.
      let childBranchStart = startMin + (i + childRng.random()) * heightStep;

      // Find which sections are on either side of the child branch origin point
      // so we can determine the origin, orientation and radius of the branch
      const sectionIndex = Math.floor(childBranchStart * (sections.length - 1));
      let sectionA, sectionB;
      sectionA = sections[sectionIndex];
      if (sectionIndex === sections.length - 1) {
        sectionB = sectionA;
      } else {
        sectionB = sections[sectionIndex + 1];
      }

      // Find normalized distance from section A to section B (0 to 1)
      const alpha =
        (childBranchStart - sectionIndex / (sections.length - 1)) /
        (1 / (sections.length - 1));

      // Linearly interpolate origin from section A to section B
      const childBranchOrigin = new THREE.Vector3().lerpVectors(
        sectionA.origin,
        sectionB.origin,
        alpha,
      );

      // Linearly interpolate radius
      // Growth: children scale with their own level's birth window (with a
      // per-child stagger), and a child whose window hasn't opened yet is
      // skipped entirely — it does not exist until its level starts growing.
      const growth = this.#growthLevel(level, this.#growthStagger(i, count));
      if (growth && growth.length < 0.36) continue;
      const childBranchRadius =
        (this.options.branch.radius[level] *
          ((1 - alpha) * sectionA.radius + alpha * sectionB.radius))
        * (growth?.radius ?? 1);

      // Linearlly interpolate the orientation
      const qA = new THREE.Quaternion().setFromEuler(sectionA.orientation);
      const qB = new THREE.Quaternion().setFromEuler(sectionB.orientation);
      const parentOrientation = new THREE.Euler().setFromQuaternion(
        qB.slerp(qA, alpha),
      );

      // Stratified radial angle: each child gets a 2π/count slot, jittered ±½ slot.
      // angleSlots[i] randomly permutes slot assignment so that the height slot
      // and angle slot are uncorrelated — otherwise evergreens (where branch
      // length depends on height) spiral their longest branches to a fixed side.
      const radialOffset = childRng.random();
      const radialJitter = childRng.random(0.5, -0.5);
      const slots = usePerBranch ? this.shuffledIndices(count, childRng) : angleSlots;
      const radialAngle = 2.0 * Math.PI * (radialOffset + (slots[i] + radialJitter) / count);
      const q1 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (childOv.angle ?? this.options.branch.angle[level]) / (180 / Math.PI),
      );
      const q2 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        radialAngle,
      );
      const q3 = new THREE.Quaternion().setFromEuler(parentOrientation);

      const childBranchOrientation = new THREE.Euler().setFromQuaternion(
        q3.multiply(q2.multiply(q1)),
      );

      let childBranchLength =
        (childOv.length ?? this.options.branch.length[level]) *
        (this.options.type === TreeType.Evergreen
          ? 1.0 - childBranchStart
          : 1.0) *
        (growth?.length ?? 1);

      // Stage D: dead branch roll. Uses a dedicated deterministic RNG keyed
      // by the child's path so it never perturbs the main generation stream.
      // Dead branches are shorter (snapped), thinner, more twisted, and
      // carry no leaves or children — a bare twig.
      const dwOpts = this.options.trunk.deadwood;
      let isDead = false;
      if (dwOpts && dwOpts.enabled && dwOpts.deadBranchChance > 0 && level > 0) {
        const deadRng = this.#makeRng(childPath + ':dead');
        isDead = deadRng.random() < dwOpts.deadBranchChance;
      }
      if (isDead) {
        childBranchLength *= (dwOpts.deadBranchLength ?? 0.6);
      }

      const childBranch = new Branch(
        childBranchOrigin,
        childBranchOrientation,
        childBranchLength,
        childBranchRadius,
        level,
        childOv.sections ?? this.options.branch.sections[level],
        childOv.segments ?? this.options.branch.segments[level],
        childPath,
        usePerBranch ? childRng : null,
      );
      if (isDead) childBranch.dead = true;
      this.branchQueue.push(childBranch);
    }
  }

  /**
   * Stage F: grows the user-placed custom branches (app: right-click a spot
   * on an existing branch → add). Each descriptor re-attaches at `t` along
   * its parent's skeleton on EVERY generate(), so the branch stays snapped
   * to its parent no matter how the parent is edited. Each one consumes a
   * dedicated deterministic RNG (never the shared stream), so adding,
   * moving or removing a user branch never reshapes the rest of the tree.
   */
  #growUserBranches() {
    const list = this.options.branch.userBranches;
    if (!list || !list.length) return;

    const byPath = new Map(this.skeleton.branches.map((b) => [b.path, b]));

    for (const ub of list) {
      // The parent may have vanished (preset/param change) — skip gracefully.
      const parent = byPath.get(ub.parentPath);
      if (!parent) continue;

      const path = `${ub.parentPath}@u${ub.id}`;
      const level = Math.min(parent.level + 1, this.options.branch.levels);
      const ov = (this.options.branch.overrides && this.options.branch.overrides[path]) || {};

      const sections = parent.sections;
      const t = Math.min(0.98, Math.max(0.02, ub.t ?? 0.5));
      const sectionIndex = Math.floor(t * (sections.length - 1));
      const sectionA = sections[sectionIndex];
      const sectionB = sectionIndex === sections.length - 1
        ? sectionA
        : sections[sectionIndex + 1];
      const alpha =
        (t - sectionIndex / (sections.length - 1)) / (1 / (sections.length - 1));

      // Growth: user branches follow their level's birth window, staggered
      // by attachment height (higher on the parent = newer growth = appears
      // a beat later) and by id. Not born yet → skip entirely.
      const growth = this.#growthLevel(level,
        -0.08 * (ub.t ?? 0.5) - 0.02 * ((ub.id ?? 0) % 4));
      if (growth && growth.length < 0.36) continue;

      // Interpolate the attach point on the parent (same math as
      // generateChildBranches): origin on the axis, radius matched to the
      // parent's local thickness, orientation rotated out by angle+radial.
      const origin = new THREE.Vector3().lerpVectors(
        sectionA.origin,
        sectionB.origin,
        alpha,
      );
      // ov.radius is parent-RELATIVE; ov.radiusAbs (set by pasteBranch) is an
      // ABSOLUTE radius that ignores the parent's local thickness — an
      // explicit relative radius (user edit) always wins.
      const radius =
        (ov.radius ??
          ov.radiusAbs ??
          this.options.branch.radius[level] *
            ((1 - alpha) * sectionA.radius + alpha * sectionB.radius))
        * (growth?.radius ?? 1);

      const qA = new THREE.Quaternion().setFromEuler(sectionA.orientation);
      const qB = new THREE.Quaternion().setFromEuler(sectionB.orientation);
      const parentOrientation = new THREE.Euler().setFromQuaternion(
        qB.slerp(qA, alpha),
      );

      const q1 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (ov.angle ?? this.options.branch.angle[level]) / (180 / Math.PI),
      );
      const q2 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        ub.radialAngle ?? 0,
      );
      const q3 = new THREE.Quaternion().setFromEuler(parentOrientation);

      const branch = new Branch(
        origin,
        new THREE.Euler().setFromQuaternion(q3.multiply(q2.multiply(q1))),
        (ov.length ?? this.options.branch.length[level]) * (growth?.length ?? 1),
        radius,
        level,
        ov.sections ?? this.options.branch.sections[level],
        ov.segments ?? this.options.branch.segments[level],
        path,
        this.#makeRng(path),
      );
      // Always use this branch's own RNG, even in 'shared' mode, and carry
      // the descriptor so the skeleton entry (and the editor UI) can find it.
      branch.forceOwnRng = true;
      branch.user = ub;

      this.branchQueue.push(branch);
      // Drain immediately so a user branch attached to another user branch
      // (added later at a lower point) can find its parent in the skeleton.
      while (this.branchQueue.length > 0) {
        this.#growBranch(this.branchQueue.shift());
      }
      for (const sb of this.skeleton.branches) {
        if (!byPath.has(sb.path)) byPath.set(sb.path, sb);
      }
    }
  }

  /**
   * Async, chunked variant of {@link #growUserBranches}. Mirrors its logic but
   * yields to the browser while draining the branch queue so a forest of
   * hand-placed branches never blocks the main thread.
   * @returns {Promise<void>}
   */
  async #growUserBranchesAsync() {
    const list = this.options.branch.userBranches;
    if (!list || !list.length) return;

    const byPath = new Map(this.skeleton.branches.map((b) => [b.path, b]));

    let processed = 0;
    for (const ub of list) {
      // The parent may have vanished (preset/param change) — skip gracefully.
      const parent = byPath.get(ub.parentPath);
      if (!parent) continue;

      const path = `${ub.parentPath}@u${ub.id}`;
      const level = Math.min(parent.level + 1, this.options.branch.levels);
      const ov = (this.options.branch.overrides && this.options.branch.overrides[path]) || {};

      const sections = parent.sections;
      const t = Math.min(0.98, Math.max(0.02, ub.t ?? 0.5));
      const sectionIndex = Math.floor(t * (sections.length - 1));
      const sectionA = sections[sectionIndex];
      const sectionB = sectionIndex === sections.length - 1
        ? sectionA
        : sections[sectionIndex + 1];
      const alpha =
        (t - sectionIndex / (sections.length - 1)) / (1 / (sections.length - 1));

      // Growth: user branches follow their level's birth window, staggered
      // by attachment height (higher on the parent = newer growth = appears
      // a beat later) and by id. Not born yet → skip entirely.
      const growth = this.#growthLevel(level,
        -0.08 * (ub.t ?? 0.5) - 0.02 * ((ub.id ?? 0) % 4));
      if (growth && growth.length < 0.36) continue;

      // Interpolate the attach point on the parent (same math as
      // generateChildBranches): origin on the axis, radius matched to the
      // parent's local thickness, orientation rotated out by angle+radial.
      const origin = new THREE.Vector3().lerpVectors(
        sectionA.origin,
        sectionB.origin,
        alpha,
      );
      // ov.radius is parent-RELATIVE; ov.radiusAbs (set by pasteBranch) is an
      // ABSOLUTE radius that ignores the parent's local thickness — an
      // explicit relative radius (user edit) always wins.
      const radius =
        (ov.radius ??
          ov.radiusAbs ??
          this.options.branch.radius[level] *
            ((1 - alpha) * sectionA.radius + alpha * sectionB.radius))
        * (growth?.radius ?? 1);

      const qA = new THREE.Quaternion().setFromEuler(sectionA.orientation);
      const qB = new THREE.Quaternion().setFromEuler(sectionB.orientation);
      const parentOrientation = new THREE.Euler().setFromQuaternion(
        qB.slerp(qA, alpha),
      );

      const q1 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (ov.angle ?? this.options.branch.angle[level]) / (180 / Math.PI),
      );
      const q2 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        ub.radialAngle ?? 0,
      );
      const q3 = new THREE.Quaternion().setFromEuler(parentOrientation);

      const branch = new Branch(
        origin,
        new THREE.Euler().setFromQuaternion(q3.multiply(q2.multiply(q1))),
        (ov.length ?? this.options.branch.length[level]) * (growth?.length ?? 1),
        radius,
        level,
        ov.sections ?? this.options.branch.sections[level],
        ov.segments ?? this.options.branch.segments[level],
        path,
        this.#makeRng(path),
      );
      // Always use this branch's own RNG, even in 'shared' mode, and carry
      // the descriptor so the skeleton entry (and the editor UI) can find it.
      branch.forceOwnRng = true;
      branch.user = ub;

      this.branchQueue.push(branch);
      // Drain immediately so a user branch attached to another user branch
      // (added later at a lower point) can find its parent in the skeleton.
      while (this.branchQueue.length > 0) {
        const b = this.branchQueue.shift();
        this.#growBranch(b);
        if ((++processed & 63) === 0) await yieldToBrowser();
      }
      for (const sb of this.skeleton.branches) {
        if (!byPath.has(sb.path)) byPath.set(sb.path, sb);
      }
    }
  }

  /**
   * Stage F: adds a user-placed branch descriptor. Does NOT regenerate —
   * call generate() afterwards. Returns the new descriptor (or null).
   * @param {number} parentIndex skeleton index of the parent branch
   * @param {number} t attachment point along the parent (0..1)
   * @param {number} radialAngle angle around the parent's axis (radians)
   */
  addUserBranch(parentIndex, t, radialAngle) {
    const parent = this.skeleton?.branches?.[parentIndex];
    if (!parent) return null;
    const list = this.options.branch.userBranches
      || (this.options.branch.userBranches = []);
    const id = list.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1;
    const ub = {
      id,
      parentPath: parent.path,
      t: Math.min(0.98, Math.max(0.02, t ?? 0.5)),
      radialAngle: radialAngle ?? 0,
    };
    list.push(ub);
    return ub;
  }

  /**
   * Stage F: moves a user branch along and/or around its parent.
   * @param {string} path user branch path, e.g. "0.2@u1"
   * @param {{t?: number, radialAngle?: number}} patch
   */
  moveUserBranch(path, { t, radialAngle } = {}) {
    const ub = (this.options.branch.userBranches || []).find(
      (u) => `${u.parentPath}@u${u.id}` === path,
    );
    if (!ub) return false;
    if (t !== undefined) ub.t = Math.min(0.98, Math.max(0.02, t));
    if (radialAngle !== undefined) ub.radialAngle = radialAngle;
    return true;
  }

  /**
   * Stage F: removes a user branch. Also drops its overrides and any user
   * branches attached to it (or to its descendants).
   * @param {string} path user branch path, e.g. "0.2@u1"
   */
  removeUserBranch(path) {
    const list = this.options.branch.userBranches || [];
    const i = list.findIndex((u) => `${u.parentPath}@u${u.id}` === path);
    if (i < 0) return false;
    list.splice(i, 1);

    // Drop overrides belonging to the removed branch and its descendants.
    if (this.options.branch.overrides) {
      for (const key of Object.keys(this.options.branch.overrides)) {
        if (key === path || key.startsWith(`${path}.`)) {
          delete this.options.branch.overrides[key];
        }
      }
    }

    // Drop user branches parented to the removed branch or its descendants.
    for (let j = list.length - 1; j >= 0; j--) {
      const p = list[j].parentPath;
      if (p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}@u`)) {
        list.splice(j, 1);
      }
    }
    return true;
  }

  /**
   * Stage F (copy/paste): resolves the parent path of a branch path.
   *   "0"          → null (trunk, no parent)
   *   "0.2"        → "0"
   *   "0.2c"       → "0.2"   (tip continuation shares the parent's level)
   *   "0.2@u1"     → "0.2"   (user branch)
   * @param {string} path
   * @returns {string|null}
   */
  #parentPathOf(path) {
    if (!path) return null;
    // Nested user branches produce paths like "0@u1@u2" — the parent is
    // everything before the LAST '@', not before the first.
    if (path.includes('@')) {
      const i = path.lastIndexOf('@');
      return i <= 0 ? null : path.slice(0, i);
    }
    if (path.endsWith('c')) return path.slice(0, -1);
    const i = path.lastIndexOf('.');
    return i < 0 ? null : path.slice(0, i);
  }

  /**
   * Stage F (copy/paste): finds where a world point sits on a parent branch —
   * the normalized distance `t` along the branch plus the radial angle of the
   * point around the branch's local axis. Lets a copied branch preserve its
   * exact attach position when re-parented elsewhere.
   * @param {object} parentSb parent skeleton branch (has .sections)
   * @param {THREE.Vector3} point world-space attach point
   * @returns {{t: number, radialAngle: number}}
   */
  #attachOnParent(parentSb, point) {
    const sections = parentSb.sections;
    if (!sections || sections.length < 2) return { t: 0.5, radialAngle: 0 };
    let best = { d: Infinity, t: 0.5, i: 0, alpha: 0 };
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i].origin;
      const b = sections[i + 1].origin;
      const ab = b.clone().sub(a);
      const len2 = ab.lengthSq() || 1e-9;
      let alpha = ab.dot(point.clone().sub(a)) / len2;
      alpha = Math.max(0, Math.min(1, alpha));
      const proj = a.clone().add(ab.multiplyScalar(alpha));
      const d = proj.distanceToSquared(point);
      if (d < best.d) best = { d, t: (i + alpha) / (sections.length - 1), i, alpha };
    }
    const secA = sections[best.i];
    const secB = sections[best.i + 1];
    const qA = new THREE.Quaternion().setFromEuler(secA.orientation);
    const qB = new THREE.Quaternion().setFromEuler(secB.orientation);
    const q = qB.clone().slerp(qA, best.alpha);
    const origin = secA.origin.clone().lerp(secB.origin, best.alpha);
    const vLocal = point.clone().sub(origin).applyQuaternion(q.clone().invert());
    return { t: best.t, radialAngle: Math.atan2(vLocal.z, vLocal.x) };
  }

  /**
   * Stage F (copy/paste): captures a branch and its entire descendant subtree
   * into a serializable, parent-independent template. Each node stores its local
   * defining params (length/radius/angle/children/gnarliness/taper/twist/
   * sections/segments/start, plus force/curve when present) and its attachment
   * (t, radialAngle) relative to its parent — so the whole sub-tree can be
   * re-parented anywhere and still keep its internal shape. A `scale` reference
   * (the original parent's radius) is stored so paste can proportionally shrink
   * the copy when it lands on a thinner branch.
   * @param {number} index skeleton branch index of the subtree root
   * @returns {{root: object, origParentRadius: number}|null}
   */
  copyBranch(index) {
    const sb = this.skeleton?.branches?.[index];
    if (!sb) return null;
    const byPath = new Map(this.skeleton.branches.map((b) => [b.path, b]));

    const buildSpec = (branch) => {
      const path = branch.path;
      const ov = (this.options.branch.overrides && this.options.branch.overrides[path]) || {};
      const level = branch.level;
      const lvlDef = (k) => this.options.branch[k][level];
      const params = {
        length: ov.length ?? lvlDef('length'),
        radius: ov.radius ?? lvlDef('radius'),
        angle: ov.angle ?? lvlDef('angle'),
        children: ov.children ?? lvlDef('children') ?? 0,
        gnarliness: ov.gnarliness ?? lvlDef('gnarliness'),
        taper: ov.taper ?? lvlDef('taper'),
        twist: ov.twist ?? lvlDef('twist'),
        sections: ov.sections ?? lvlDef('sections'),
        segments: ov.segments ?? lvlDef('segments'),
        start: ov.start ?? lvlDef('start') ?? 0.3,
      };
      if (ov.force) params.force = ov.force;
      if (ov.curve) params.curve = ov.curve;

      // Actual absolute base radius from the skeleton — needed so paste can
      // preserve the *visual* thickness (nominal radius is parent-relative).
      const absRadius = branch.baseRadius ?? branch.radius ?? 1;

      let attach = { t: 0.5, radialAngle: 0 };
      const parentPath = this.#parentPathOf(path);
      if (branch.user) {
        attach = { t: branch.user.t ?? 0.5, radialAngle: branch.user.radialAngle ?? 0 };
      } else if (parentPath && byPath.has(parentPath)) {
        attach = this.#attachOnParent(byPath.get(parentPath), branch.sections[0].origin);
      }

      const children = this.skeleton.branches
        .filter((b) => this.#parentPathOf(b.path) === path)
        .map(buildSpec);

      return { params, attach, children, absRadius };
    };

    const origParentPath = this.#parentPathOf(sb.path);
    const origParentRadius = (origParentPath && byPath.get(origParentPath)?.baseRadius)
      || sb.baseRadius
      || 1;

    return { root: buildSpec(sb), origParentRadius: Math.max(1e-3, origParentRadius) };
  }

  /**
   * Stage F (copy/paste): re-creates a copied subtree (from {@link copyBranch})
   * as new user branches parented under `parentIndex`. The subtree's internal
   * shape is preserved; lengths & radii are scaled by the ratio of the new
   * parent's radius to the original parent's radius, so pasting onto a thin
   * twig shrinks the whole copy while pasting onto the trunk keeps it full size.
   * Every pasted branch gets `children: 0` so it does not also auto-spawn the
   * default procedural children (the copied children are re-created explicitly).
   * Does NOT regenerate — call generate() afterwards. Returns the new paths.
   * @param {number} parentIndex skeleton branch index of the new parent
   * @param {{root: object, origParentRadius: number}} clipboard
   * @returns {string[]|null}
   */
  pasteBranch(parentIndex, clipboard) {
    const parent = this.skeleton?.branches?.[parentIndex];
    if (!parent || !clipboard || !clipboard.root) return null;

    const list = this.options.branch.userBranches
      || (this.options.branch.userBranches = []);
    const overrides = this.options.branch.overrides
      || (this.options.branch.overrides = {});

    let nextId = list.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1;
    const s = (parent.baseRadius && clipboard.origParentRadius)
      ? Math.max(0.01, parent.baseRadius / clipboard.origParentRadius)
      : 1;

    // #growBranch amplifies gnarliness by max(1, 1/sqrt(radius)). When the
    // subtree is uniformly scaled by s, compensating the nominal gnarliness by
    // the amp ratio keeps the pasted copy's bend angles identical to the
    // source's (otherwise a thick branch pasted onto a twig coils up).
    const gnarlComp = (srcAbsRadius) => {
      const r0 = Math.max(1e-4, srcAbsRadius || 1);
      const r1 = Math.max(1e-4, r0 * s);
      const amp0 = Math.max(1, 1 / Math.sqrt(r0));
      const amp1 = Math.max(1, 1 / Math.sqrt(r1));
      return amp0 / amp1;
    };

    const created = [];
    const pasteNode = (spec, parentPath) => {
      const id = nextId++;
      const t = Math.min(0.98, Math.max(0.02, spec.attach.t ?? 0.5));
      const ub = {
        id,
        parentPath,
        t,
        radialAngle: spec.attach.radialAngle ?? 0,
      };
      list.push(ub);
      const path = `${parentPath}@u${id}`;

      const comp = gnarlComp(spec.absRadius);
      const ov = { children: 0 };
      for (const k of ['length', 'angle', 'gnarliness', 'taper', 'twist', 'sections', 'segments', 'start']) {
        let v = spec.params[k];
        if (v === undefined || v === null) continue;
        if (k === 'length') v = v * s;
        if (k === 'gnarliness') v = v * comp;
        ov[k] = v;
      }
      // Absolute radius: preserves the source's visual thickness × s exactly,
      // independent of the new parent's local taper/level quirks. (The
      // user-branch grower prefers an explicit ov.radius if the user edits it
      // later.) Leaves on the pasted subtree scale by the same factor.
      ov.radiusAbs = Math.max(1e-4, (spec.absRadius ?? spec.params.radius ?? 1) * s);
      ov.leafScale = s;
      if (spec.params.force) ov.force = spec.params.force;
      if (spec.params.curve) ov.curve = spec.params.curve;
      overrides[path] = ov;

      // Record BEFORE recursing so created[0] is always the subtree root.
      created.push(path);
      for (const child of spec.children) pasteNode(child, path);
    };

    pasteNode(clipboard.root, parent.path);
    return created;
  }

  /**
   * Stage F: converts a world-space point on/near a branch into an
   * attachment descriptor (t along the branch + radial angle around its
   * axis at that point). Used by the app's right-click "add branch here".
   * @param {number} index skeleton branch index
   * @param {THREE.Vector3} point world-space hit point
   * @returns {{t: number, radialAngle: number}|null}
   */
  getBranchAttachFromPoint(index, point) {
    const sb = this.skeleton?.branches?.[index];
    if (!sb || sb.sections.length < 2) return null;
    const sections = sb.sections;

    // Nearest segment (3D point-to-segment distance).
    let best = { dist: Infinity, i: 0, alpha: 0 };
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i].origin;
      const b = sections[i + 1].origin;
      const ab = new THREE.Vector3().subVectors(b, a);
      const len2 = ab.lengthSq();
      const alpha = len2 > 1e-10
        ? Math.max(0, Math.min(1, new THREE.Vector3().subVectors(point, a).dot(ab) / len2))
        : 0;
      const p = new THREE.Vector3().copy(a).addScaledVector(ab, alpha);
      const dist = p.distanceToSquared(point);
      if (dist < best.dist) best = { dist, i, alpha };
    }

    const t = Math.min(0.98, Math.max(0.02, (best.i + best.alpha) / (sections.length - 1)));

    // Radial angle of the hit point in the local frame of that section.
    const section = sections[best.i + (best.alpha > 0.5 && best.i + 1 < sections.length ? 1 : 0)];
    const q = new THREE.Quaternion().setFromEuler(section.orientation).invert();
    const local = new THREE.Vector3().subVectors(point, section.origin).applyQuaternion(q);
    const radialAngle = Math.atan2(local.z, local.x);

    return { t, radialAngle };
  }

  /**
   * Logic for spawning child branches from a parent branch's section
   * @param {{
   *  origin: THREE.Vector3,
   *  orientation: THREE.Euler,
   *  radius: number
   * }[]} sections The parent branch's sections
   * @param {number} [leafScaleMult] Per-branch leaf size multiplier (set by
   *  pasteBranch so a pasted, uniformly scaled subtree gets proportionally
   *  scaled leaves too). Defaults to 1.
   * @param {number} [growthMult=1] Leaf-count multiplier for the growth
   *  animation: a branch that is still elongating carries proportionally
   *  fewer leaves (0.35 → 1 as the branch matures).
   * @returns
   */
  generateLeaves(sections, rng, branchLength, leafScaleMult = 1, growthMult = 1) {
    const radialOffset = rng.random();
    const baseCount = this.options.leaves.count;

    // Density: scale the leaf count with this branch's length relative to the
    // trunk so long branches stay well covered on large trees. density = 0
    // leaves the count unchanged (legacy behavior).
    const density = this.options.leaves.density || 0;
    const factor = Math.max(0.1, 1 + density * (branchLength / (this.trunkLength || 1) - 1));
    const count = Math.max(1, Math.round(baseCount * factor * growthMult));

    const startMin = this.options.leaves.start;
    const heightStep = (1.0 - startMin) / count;
    const angleSlots = this.shuffledIndices(count, rng);

    for (let i = 0; i < count; i++) {
      // Stratified sampling along the parent's length.
      let leafStart = startMin + (i + rng.random()) * heightStep;

      // Find which sections are on either side of the child branch origin point
      // so we can determine the origin, orientation and radius of the branch
      const sectionIndex = Math.floor(leafStart * (sections.length - 1));
      let sectionA, sectionB;
      sectionA = sections[sectionIndex];
      if (sectionIndex === sections.length - 1) {
        sectionB = sectionA;
      } else {
        sectionB = sections[sectionIndex + 1];
      }

      // Find normalized distance from section A to section B (0 to 1)
      const alpha =
        (leafStart - sectionIndex / (sections.length - 1)) /
        (1 / (sections.length - 1));

      // Linearly interpolate origin from section A to section B
      const leafOrigin = new THREE.Vector3().lerpVectors(
        sectionA.origin,
        sectionB.origin,
        alpha,
      );

      // Linearlly interpolate the orientation
      const qA = new THREE.Quaternion().setFromEuler(sectionA.orientation);
      const qB = new THREE.Quaternion().setFromEuler(sectionB.orientation);
      const parentOrientation = new THREE.Euler().setFromQuaternion(
        qB.slerp(qA, alpha),
      );

      // Stratified radial angle with permuted slot assignment.
      // See generateChildBranches for rationale.
      const radialJitter = rng.random(0.5, -0.5);
      const radialAngle = 2.0 * Math.PI * (radialOffset + (angleSlots[i] + radialJitter) / count);
      const q1 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        this.options.leaves.angle / (180 / Math.PI),
      );
      const q2 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        radialAngle,
      );
      const q3 = new THREE.Quaternion().setFromEuler(parentOrientation);

      const leafOrientation = new THREE.Euler().setFromQuaternion(
        q3.multiply(q2.multiply(q1)),
      );

      this.#recordLeaf(leafOrigin, leafOrientation, rng, leafScaleMult);
    }
  }

  /**
   * Stage B: sprouts tapering root fingers from the base of the trunk.
   * Each root radiates outward and dives downward, fading to a fine tip.
   * Placement and per-root jitter are drawn from a DEDICATED deterministic
   * RNG keyed by the trunk path, so enabling roots never perturbs the main
   * generation stream or the rest of the tree's shape. The roots are pushed
   * straight into skeleton.branches, so they reuse #meshBranch and the bark
   * material, and are even pickable like any other branch.
   * @param {{origin: THREE.Vector3, orientation: THREE.Euler, radius: number, t: number}[]} sections
   * @param {object} butt this.options.trunk.buttress
   */
  #generateRoots(sections, butt, basePath = '0') {
    const base = sections[0];
    if (!base) return;
    const rrng = this.#makeRng(basePath + ':buttress-roots');
    const count = Math.max(0, Math.round(butt.roots));
    if (count <= 0) return;

    const phase0 = rrng.random() * Math.PI * 2;
    const baseR = base.radius;

    for (let k = 0; k < count; k++) {
      const theta = phase0 + (k * 2 * Math.PI) / count + rrng.random(-0.25, 0.25);
      const outDir = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
      const startR = baseR * (butt.rootWidth ?? 0.6) * rrng.random(0.7, 1.05);
      const length = butt.rootLength * rrng.random(0.8, 1.25);
      const depth = butt.rootDepth * rrng.random(0.6, 1.1);

      // Emerge from just outside the trunk base, at/above the ground plane.
      const start = base.origin.clone().add(outDir.clone().multiplyScalar(startR));
      start.y = Math.max(start.y, 0.05);

      // Grow outward then downward; keep the cross-sections perpendicular to
      // the root axis so it reads as a root, not a tilted cylinder.
      const dir = new THREE.Vector3().copy(outDir).multiplyScalar(length);
      dir.y -= depth;
      dir.normalize();
      const end = start.clone().add(dir.clone().multiplyScalar(length));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const e = new THREE.Euler().setFromQuaternion(q);
      const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, startR * 0.15, 0));

      const segs = [
        { origin: start.clone(), orientation: e.clone(), radius: startR },
        { origin: mid, orientation: e.clone(), radius: startR * 0.45 },
        { origin: end.clone(), orientation: e.clone(), radius: startR * 0.12 },
      ];

      this.skeleton.branches.push({
        sections: segs,
        segmentCount: 6,
        baseRadius: startR,
        path: basePath + '.root' + k,
        level: 0,
        length: end.distanceTo(start),
      });
    }
  }

  /**
  * Records a leaf placement in the skeleton. The size variance is sampled
  * here so the meshing passes stay RNG-free.
  * @param {THREE.Vector3} origin The starting point of the leaf
  * @param {THREE.Euler} orientation The orientation of the leaf
  * @param {RNG} rng The stream to sample size variance from
  * @param {number} [scaleMult] Per-branch leaf scale (pasted subtrees)
  */
  #recordLeaf(origin, orientation, rng, scaleMult = 1) {
    const size =
      this.options.leaves.size *
      scaleMult *
      (1 +
        rng.random(
          this.options.leaves.sizeVariance,
          -this.options.leaves.sizeVariance,
        ));

    // Stage C: when cloud-slab foliage is enabled, sample a per-leaf slab
    // descriptor here (RNG consumed now, meshing stays RNG-free so LOD
    // re-meshing is deterministic). Tilt is a small random rotation about a
    // random horizontal axis, plus a random spin about vertical so clusters
    // are not all aligned.
    const slabOpts = this.options.leaves.slab;
    let slab = null;
    if (slabOpts && slabOpts.enabled) {
      const tiltRad = rng.random(0, (slabOpts.tilt * Math.PI) / 180);
      const axisAngle = rng.random(0, Math.PI * 2);
      const axis = new THREE.Vector3(Math.cos(axisAngle), 0, Math.sin(axisAngle));
      const spin = rng.random(0, Math.PI * 2);
      const q = new THREE.Quaternion()
        .setFromAxisAngle(axis, tiltRad)
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin),
        );
      slab = {
        radius: slabOpts.radius * scaleMult * (1 + rng.random(slabOpts.radiusVariance, -slabOpts.radiusVariance)),
        thickness: slabOpts.thickness,
        layers: slabOpts.layers,
        segments: slabOpts.segments,
        tilt: new THREE.Euler().setFromQuaternion(q),
      };
    }

    this.skeleton.leaves.push({
      origin: origin.clone(),
      orientation: orientation.clone(),
      size,
      slab,
    });
  }

  /**
  * Emits the quad geometry for one skeleton leaf into the buffers
  * @param {{verts: number[], normals: number[], indices: number[], uvs: number[]}} buffers
  * @param {{origin: THREE.Vector3, orientation: THREE.Euler, size: number}} leaf
  * @param {number} scale Size multiplier for this detail level
  * @param {string} billboard Billboard mode for this detail level
  */
  #meshLeaf(buffers, leaf, scale, billboard) {
    let i = buffers.verts.length / 3;

    const { origin, orientation } = leaf;

    // Width and length of the leaf quad
    const leafSize = leaf.size * scale;

    const W = leafSize;
    const L = leafSize;

    const createLeaf = (rotation) => {
      // Create quad vertices
      const v = [
        new THREE.Vector3(-W / 2, L, 0),
        new THREE.Vector3(-W / 2, 0, 0),
        new THREE.Vector3(W / 2, 0, 0),
        new THREE.Vector3(W / 2, L, 0),
      ].map((v) =>
        v
          .applyEuler(new THREE.Euler(0, rotation, 0))
          .applyEuler(orientation)
          .add(origin),
      );

      buffers.verts.push(
        v[0].x,
        v[0].y,
        v[0].z,
        v[1].x,
        v[1].y,
        v[1].z,
        v[2].x,
        v[2].y,
        v[2].z,
        v[3].x,
        v[3].y,
        v[3].z,
      );

      const n = new THREE.Vector3(0, 0, 1).applyEuler(orientation);

      // The normal vectors are an average of the direction of the leaf and the directions to the individual vertices.
      // This creates a nice rounded shape while maintaining the canopy shape as a whole.
      const roundedNormals = this.options.leaves.roundedNormals;
      let n1 = roundedNormals ? new THREE.Vector3().copy(n).add(v[0]).sub(origin).normalize() : n;
      let n2 = roundedNormals ? new THREE.Vector3().copy(n).add(v[1]).sub(origin).normalize() : n;
      let n3 = roundedNormals ? new THREE.Vector3().copy(n).add(v[2]).sub(origin).normalize() : n;
      let n4 = roundedNormals ? new THREE.Vector3().copy(n).add(v[3]).sub(origin).normalize() : n;

      buffers.normals.push(
        n1.x,
        n1.y,
        n1.z,
        n2.x,
        n2.y,
        n2.z,
        n3.x,
        n3.y,
        n3.z,
        n4.x,
        n4.y,
        n4.z,
      );
      buffers.uvs.push(0, 1, 0, 0, 1, 0, 1, 1);
      buffers.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
      i += 4;
    };

    createLeaf(0);
    if (billboard === Billboard.Double) {
      createLeaf(Math.PI / 2);
    }
  }

  /**
   * Emits flat horizontal "cloud-slab" foliage (云片叶簇) for one skeleton
   * leaf. Each cluster is `layers` stacked horizontal discs (triangle fans)
   * in the local XZ plane, slightly offset in Y so it reads as a layered
   * puff rather than a single sheet. The whole cluster is tilted by a small
   * per-leaf angle. It lives in the same leavesMesh (shared wind material)
   * but uses uv.y = 0 on every vertex, so the wind sway leaves these large
   * puffs essentially still — unlike the fluttering billboard leaves.
   * @param {{verts: number[], normals: number[], uvs: number[], indices: number[]}} buffers
   * @param {{origin: THREE.Vector3, slab: {radius: number, thickness: number, layers: number, segments: number, tilt: THREE.Euler}}} leaf
   * @param {number} scale Size multiplier for this detail level
   */
  #meshSlab(buffers, leaf, scale) {
    const { origin, slab } = leaf;
    if (!slab) return;

    const R = Math.max(0.001, slab.radius * scale);
    const thickness = Math.max(0, slab.thickness * scale);
    const layers = Math.max(1, slab.layers | 0);
    const segs = Math.max(3, slab.segments | 0);
    const tiltQ = new THREE.Quaternion().setFromEuler(slab.tilt);

    // Shared up-normal of the (tilted) cluster; DoubleSide material so the
    // underside shades correctly too.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(tiltQ);

    for (let L = 0; L < layers; L++) {
      // Stack layers around the origin; the middle layer is widest for a
      // puffy silhouette, outer layers taper.
      const off = (L - (layers - 1) / 2) / Math.max(1, (layers - 1) / 2);
      const yOff = off * thickness;
      const layerR = R * (1 - 0.2 * Math.abs(off));

      const base = buffers.verts.length / 3;
      const center = new THREE.Vector3(0, yOff, 0).applyQuaternion(tiltQ).add(origin);
      buffers.verts.push(center.x, center.y, center.z);
      buffers.normals.push(up.x, up.y, up.z);
      buffers.uvs.push(0, 0);

      const ringStart = base + 1;
      for (let j = 0; j < segs; j++) {
        const a = (2 * Math.PI * j) / segs;
        const v = new THREE.Vector3(Math.cos(a) * layerR, yOff, Math.sin(a) * layerR)
          .applyQuaternion(tiltQ)
          .add(origin);
        buffers.verts.push(v.x, v.y, v.z);
        buffers.normals.push(up.x, up.y, up.z);
        buffers.uvs.push(j / segs, 0);
      }

      // Triangle fan: center + consecutive ring vertices.
      for (let j = 0; j < segs; j++) {
        const a = ringStart + j;
        const b = ringStart + ((j + 1) % segs);
        buffers.indices.push(base, a, b);
      }
    }
  }

  /**
   * Fisher-Yates shuffle of [0..count-1] using the supplied RNG so results
   * stay seed-reproducible.
   * @param {number} count
   * @param {RNG} rng
   * @returns {number[]}
   */
  shuffledIndices(count, rng) {
    const arr = Array.from({ length: count }, (_, k) => k);
    for (let k = count - 1; k > 0; k--) {
      const r = Math.floor(rng.random() * (k + 1));
      [arr[k], arr[r]] = [arr[r], arr[k]];
    }
    return arr;
  }

  /**
   * Emits the ring geometry and indices for one skeleton branch
   * @param {{verts: number[], normals: number[], indices: number[], uvs: number[], branchIndex: number[]}} buffers
   * @param {{sections: {origin: THREE.Vector3, orientation: THREE.Euler, radius: number}[], segmentCount: number, baseRadius: number}} skeletonBranch
   * @param {number} branchIndex Stable index of this branch in skeleton.branches
   * @param {number} sectionStride Sample every Nth section ring
   * @param {number} segmentFactor Radial segment multiplier
   */
  #meshBranch(buffers, skeletonBranch, branchIndex, sectionStride, segmentFactor) {
    const { sections, segmentCount, baseRadius } = skeletonBranch;

    // Terminal branches inherit the parent's segmentCount, so parent and
    // child resolve to the same reduced count and junctions stay sealed.
    const segments = Math.max(3, Math.round(segmentCount * segmentFactor));

    // Number of texture wraps around the branch's circumference. Scaling with
    // the branch's base radius keeps bark feature size roughly consistent
    // across thick trunks and thin twigs. Held constant for the whole branch
    // so tapered sections share a wrap count and don't twist the texture
    // longitudinally.
    const wrapsX = Math.max(
      1,
      Math.round(baseRadius * this.options.bark.textureScale.x),
    );

    // Sample every Nth ring, always keeping the first and last so branch
    // endpoints (and parent/child junctions) stay put across detail levels.
    const sampled = [];
    for (let i = 0; i < sections.length; i += sectionStride) {
      sampled.push(sections[i]);
    }
    if ((sections.length - 1) % sectionStride !== 0) {
      sampled.push(sections[sections.length - 1]);
    }

    if (!buffers.branchIndex) buffers.branchIndex = [];

    // Used later for geometry index generation
    const indexOffset = buffers.verts.length / 3;

    for (let k = 0; k < sampled.length; k++) {
      const section = sampled[k];

      // Stage B buttress flutes: a radial ridge profile carved into the lower
      // trunk. Computed per-vertex from the section's own angle so it is
      // independent of the radial segment count (LOD-safe) and consistent
      // across detail levels. Fades to 1 (no ridge) by buttress.height.
      const butt = skeletonBranch.buttress;
      const buttFade = (butt && section.t != null && section.t <= butt.height)
        ? 1 - section.t / butt.height
        : 0;

      // Stage D: deadwood (hollow + cracks) — trunk only.
      const dw = skeletonBranch.deadwood;

      // Create the segments that make up this section.
      let first;
      for (let j = 0; j < segments; j++) {
        let angle = (2.0 * Math.PI * j) / segments;

        // Effective radius after buttress flute + deadwood modulation.
        let rEff = buttFade > 0
          ? section.radius * (1 + butt.strength * buttFade * Math.cos(butt.flutes * angle - butt.phase))
          : section.radius;

        // Stage D: hollow (localized inward dent) + cracks (narrow vertical grooves).
        // Both are Gaussian falloffs in angle so they are LOD-safe (independent
        // of segment count, consistent across detail levels).
        if (dw) {
          const st = section.t ?? 0;
          // Hollow: dent centered at hollowPhase/hollowHeight, fading in both
          // angle and height. The 0.15 constant controls the vertical spread.
          const angDistH = this.#angleDelta(angle, dw.hollowPhase);
          const hollowAF = Math.exp(-Math.pow(angDistH / dw.hollowWidth, 2));
          const hDist = Math.abs(st - dw.hollowHeight);
          const hollowHF = Math.exp(-Math.pow(hDist / 0.15, 2));
          rEff *= 1 - dw.hollowStrength * hollowAF * hollowHF;

          // Cracks: narrow grooves evenly distributed around the trunk,
          // offset by crackPhase. Fade out near the top so cracks read as
          // weathered fissures, not through-holes.
          if (dw.crackCount > 0) {
            const crackFade = st < 0.85 ? 1 : Math.max(0, 1 - (st - 0.85) / 0.15);
            for (let c = 0; c < dw.crackCount; c++) {
              const crackAngle = dw.crackPhase + (c * 2 * Math.PI / dw.crackCount);
              const crackDist = this.#angleDelta(angle, crackAngle);
              const crackF = Math.exp(-Math.pow(crackDist / dw.crackWidth, 2));
              rEff *= 1 - dw.crackDepth * crackF * crackFade;
            }
          }
        }

        // Create the segment vertex
        const vertex = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
          .multiplyScalar(rEff)
          .applyEuler(section.orientation)
          .add(section.origin);

        const normal = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
          .applyEuler(section.orientation)
          .normalize();

        // uv.y alternates by sampled ring position rather than original
        // section index, so section skipping keeps the 0/1 tiling pattern.
        const uv = new THREE.Vector2(
          (j / segments) * wrapsX,
          (k % 2 === 0) ? 0 : 1,
        );

        buffers.verts.push(...Object.values(vertex));
        buffers.normals.push(...Object.values(normal));
        buffers.uvs.push(...Object.values(uv));
        buffers.branchIndex.push(branchIndex);

        if (j === 0) {
          first = { vertex, normal, uv };
        }
      }

      // Duplicate the first vertex so there is continuity in the UV mapping.
      // u=wrapsX maps to the same texel as u=0 since wrapsX is an integer.
      buffers.verts.push(...Object.values(first.vertex));
      buffers.normals.push(...Object.values(first.normal));
      buffers.uvs.push(wrapsX, first.uv.y);
      buffers.branchIndex.push(branchIndex);
    }

    // Build geometry for each section of the branch (cylinder without end caps)
    let v1, v2, v3, v4;
    const N = segments + 1;
    for (let i = 0; i < sampled.length - 1; i++) {
      // Build the quad for each segment of the section
      for (let j = 0; j < segments; j++) {
        v1 = indexOffset + i * N + j;
        // The last segment wraps around back to the starting segment, so omit j + 1 term
        v2 = indexOffset + i * N + (j + 1);
        v3 = v1 + N;
        v4 = v2 + N;
        buffers.indices.push(v1, v3, v2, v2, v3, v4);
      }
    }

    // Stage F: end caps. Tube sections are open at their ends — dead/snapped
    // branches, exposed root tips and user-placed branches would show a hole.
    // A triangle fan from a center vertex closes them. The fan reuses the
    // ring vertices already emitted above, so caps are identical across LOD
    // detail levels. The trunk's base is also capped (facing down) so the
    // ground line never shows through; child branch bases are embedded in
    // their parent and stay uncapped.
    if (this.options.branch.capEnds !== false) {
      // Tip cap — skip degenerate fans on near-zero-radius terminal rings.
      const lastIdx = sampled.length - 1;
      const lastSection = sampled[lastIdx];
      if (lastSection.radius > 0.0015) {
        const centerIndex = buffers.verts.length / 3;
        const up = new THREE.Vector3(0, 1, 0)
          .applyEuler(lastSection.orientation)
          .normalize();
        const uvY = lastIdx % 2 === 0 ? 0 : 1;
        buffers.verts.push(lastSection.origin.x, lastSection.origin.y, lastSection.origin.z);
        buffers.normals.push(up.x, up.y, up.z);
        buffers.uvs.push(wrapsX * 0.5, uvY);
        buffers.branchIndex.push(branchIndex);
        const ringStart = indexOffset + lastIdx * N;
        for (let j = 0; j < segments; j++) {
          // (center, j+1, j) faces along the branch's +axis
          buffers.indices.push(centerIndex, ringStart + j + 1, ringStart + j);
        }
      }

      // Base cap — trunk only.
      if (skeletonBranch.level === 0) {
        const firstSection = sampled[0];
        const centerIndex = buffers.verts.length / 3;
        const down = new THREE.Vector3(0, -1, 0)
          .applyEuler(firstSection.orientation)
          .normalize();
        buffers.verts.push(firstSection.origin.x, firstSection.origin.y, firstSection.origin.z);
        buffers.normals.push(down.x, down.y, down.z);
        buffers.uvs.push(wrapsX * 0.5, 0);
        buffers.branchIndex.push(branchIndex);
        const ringStart = indexOffset;
        for (let j = 0; j < segments; j++) {
          // (center, j, j+1) faces along the branch's -axis
          buffers.indices.push(centerIndex, ringStart + j, ringStart + j + 1);
        }
      }
    }
  }

  /**
   * Builds a BufferGeometry from raw attribute buffers
   * @param {{verts: number[], normals: number[], indices: number[], uvs: number[], branchIndex?: number[]}} buffers
   * @returns {THREE.BufferGeometry}
   */
  #buildBufferGeometry(buffers) {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(buffers.verts), 3),
    );
    g.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(buffers.normals), 3),
    );
    g.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array(buffers.uvs), 2),
    );
    if (buffers.branchIndex && buffers.branchIndex.length) {
      g.setAttribute(
        'aBranchIndex',
        new THREE.BufferAttribute(new Float32Array(buffers.branchIndex), 1),
      );
    }
    g.setIndex(
      new THREE.BufferAttribute(new Uint16Array(buffers.indices), 1),
    );
    g.computeBoundingSphere();
    return g;
  }

  /**
   * Creates the bark material from the current options
   * @returns {THREE.MeshStandardMaterial}
   */
  #createBarkMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      name: 'branches',
      flatShading: this.options.bark.flatShading,
      color: new THREE.Color(this.options.bark.tint),
      metalness: 0.0,
      roughness: 1.0,
    });

    if (this.options.bark.textured) {
      // textureScale.x is baked into UVs during meshing (wrapsX), so only
      // the Y axis needs runtime scaling on the texture itself.
      const scale = this.options.bark.textureScale;
      const maps = this.options.bark.maps;
      const apply = (texture) => {
        if (!texture) return null;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.x = 1;
        texture.repeat.y = 1 / scale.y;
        return texture;
      };
      if (maps.color) mat.map = apply(maps.color);
      if (maps.ao) mat.aoMap = apply(maps.ao);
      if (maps.normal) mat.normalMap = apply(maps.normal);
      if (maps.roughness) {
        mat.roughnessMap = apply(maps.roughness);
        // Point metalnessMap at the same texture: metalness stays 0 because
        // the metalness factor is 0, and GLTFExporter reuses the texture
        // as-is instead of synthesizing a merged metal/rough PNG (and
        // warning about it) when the two slots differ.
        mat.metalnessMap = mat.roughnessMap;
      }
    }

    return mat;
  }

  /**
   * Generates the geometry for the branches
   */
  createBranchesGeometry() {
    this.branchesMesh.geometry.dispose();
    this.branchesMesh.geometry = this.#buildBufferGeometry(this.branches);
    this.branchesMesh.material.dispose();
    this.branchesMesh.material = this.#createBarkMaterial();
    this.branchesMesh.castShadow = true;
    this.branchesMesh.receiveShadow = true;
  }

  /**
   * Creates the leaf material, including the wind sway vertex shader, from
   * the current options
   * @returns {THREE.MeshStandardMaterial}
   */
  #createLeafMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      name: 'leaves',
      map: this.options.leaves.map ?? null,
      color: new THREE.Color(this.options.leaves.tint),
      side: THREE.DoubleSide,
      alphaTest: this.options.leaves.alphaTest,
      metalness: 0.0,
      roughness: 1.0,
      dithering: true
    });

    // Add custom shader code for branch swaying
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uWindStrength = { value: new THREE.Vector3(0.5, 0, 0.5) };
      shader.uniforms.uWindFrequency = { value: 0.5 };
      shader.uniforms.uWindScale = { value: 70 };
      shader.uniforms.uCustomNormals = { value: this.options.leaves.roundedNormals };

      shader.vertexShader = `
        uniform float uTime;
        uniform vec3 uWindStrength;
        uniform float uWindFrequency;
        uniform float uWindScale;
        ` + shader.vertexShader;

      // Add code for simplex noise
      shader.vertexShader = shader.vertexShader.replace(
        `void main() {`,
        `
        // GLSL Simplex Noise 3D
        // Source: https://github.com/ashima/webgl-noise

        vec3 mod289(vec3 x) {
            return x - floor(x * (1.0 / 289.0)) * 289.0;
        }

        vec4 mod289(vec4 x) {
            return x - floor(x * (1.0 / 289.0)) * 289.0;
        }

        vec4 permute(vec4 x) {
            return mod289(((x*34.0)+1.0)*x);
        }

        vec4 taylorInvSqrt(vec4 r) {
            return 1.79284291400159 - 0.85373472095314 * r;
        }

        vec3 fade(vec3 t) {
            return t*t*t*(t*(t*6.0-15.0)+10.0);
        }

        // Classic Simplex Noise 3D
        float simplex3(vec3 v) {
            const vec2  C = vec2(1.0/6.0, 1.0/3.0);
            const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

            // First corner
            vec3 i  = floor(v + dot(v, C.yyy) );
            vec3 x0 = v - i + dot(i, C.xxx);

            // Other corners
            vec3 g = step(x0.yzx, x0.xyz);
            vec3 l = 1.0 - g;
            vec3 i1 = min( g.xyz, l.zxy );
            vec3 i2 = max( g.xyz, l.zxy );

            //  x0 = x0 - 0. + 0.0 * C
            vec3 x1 = x0 - i1 + C.xxx;
            vec3 x2 = x0 - i2 + C.yyy; // 2.0 * C.x = 1/3 = C.y
            vec3 x3 = x0 - D.yyy;      // -1.0 + 3.0 * C.x = -0.5

            // Permutations
            i = mod289(i);
            vec4 p = permute( permute( permute(
                        i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
                      + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
                      + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

            // Gradients: 7x7 points over a square, mapped onto an octahedron.
            // The ring size 17*17 = 289 is close to the mapping's singularity.
            float n_ = 0.142857142857; // 1.0/7.0
            vec3  ns = n_ * D.wyz - D.xzx;

            vec4 j = p - 49.0 * floor(p * ns.z * ns.z);  //  mod(p,7*7)

            vec4 x_ = floor(j * ns.z);
            vec4 y_ = floor(j - 7.0 * x_ );    // mod(j,N)

            vec4 x = x_ *ns.x + ns.yyyy;
            vec4 y = y_ *ns.x + ns.yyyy;
            vec4 h = 1.0 - abs(x) - abs(y);

            vec4 b0 = vec4( x.xy, y.xy );
            vec4 b1 = vec4( x.zw, y.zw );

            vec4 s0 = floor(b0)*2.0 + 1.0;
            vec4 s1 = floor(b1)*2.0 + 1.0;
            vec4 sh = -step(h, vec4(0.0));

            vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
            vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

            vec3 g0 = vec3(a0.xy,h.x);
            vec3 g1 = vec3(a0.zw,h.y);
            vec3 g2 = vec3(a1.xy,h.z);
            vec3 g3 = vec3(a1.zw,h.w);

            // Normalise gradients
            vec4 norm = taylorInvSqrt(vec4(dot(g0,g0), dot(g1,g1), dot(g2,g2), dot(g3,g3)));
            g0 *= norm.x;
            g1 *= norm.y;
            g2 *= norm.z;
            g3 *= norm.w;

            // Mix contributions from the four corners
            vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
            m = m * m;
            return 42.0 * dot( m*m, vec4( dot(g0,x0), dot(g1,x1),
                                          dot(g2,x2), dot(g3,x3) ) );
        }

        void main() {`,
      );

      shader.vertexShader = shader.vertexShader.replace(
        `#include <project_vertex>`,
        `
        vec4 mvPosition = vec4(transformed, 1.0);

        float windOffset = 2.0 * 3.14 * simplex3(mvPosition.xyz / uWindScale);
        vec3 windSway = uv.y * uWindStrength * (
          0.5 * sin(uTime * uWindFrequency + windOffset) +
          0.3 * sin(2.0 * uTime * uWindFrequency + 1.3 * windOffset) +
          0.2 * sin(5.0 * uTime * uWindFrequency + 1.5 * windOffset)
        );
        mvPosition.xyz += windSway;

        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        `
      );

      // Skip the backface normal flip in normal_fragment_begin when using custom normals
      shader.fragmentShader = `uniform bool uCustomNormals;\n` + shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace(
          'normal *= faceDirection;',
          'if (!uCustomNormals) { normal *= faceDirection; }'
        )
      );

      // Non-enumerable so JSON serialization (e.g. GLTFExporter's userData
      // pass) skips the live shader object — Texture uniforms inside it are
      // not serializable. update() still reads userData.shader normally.
      Object.defineProperty(mat.userData, 'shader', {
        value: shader,
        configurable: true,
        enumerable: false,
      });
    };

    return mat;
  }

  /**
   * Generates the geometry for the leaves
   */
  createLeavesGeometry() {
    this.leavesMesh.geometry.dispose();
    this.leavesMesh.geometry = this.#buildBufferGeometry(this.leaves);
    this.leavesMesh.material.dispose();
    this.leavesMesh.material = this.#createLeafMaterial();
    this.leavesMesh.castShadow = true;
    this.leavesMesh.receiveShadow = true;
  }

  /**
   * Create or update the trellis geometry
   */
  createTrellis() {
    // Remove old trellis if exists
    if (this.trellisMesh) {
      this.remove(this.trellisMesh);
      this.trellisMesh.dispose();
      this.trellisMesh = null;
    }

    // Create new trellis if enabled and visible
    if (this.options.trellis.enabled && this.options.trellis.visible) {
      this.trellisMesh = new Trellis(this.options.trellis);
      this.trellisMesh.generate();
      this.add(this.trellisMesh);
    }
  }

  /**
   * Find the nearest point on the trellis grid to a given position
   * @param {THREE.Vector3} position
   * @returns {THREE.Vector3}
   */
  getNearestTrellisPoint(position) {
    const t = this.options.trellis;
    const trellisX = t.position.x;
    const trellisY = t.position.y;
    const trellisZ = t.position.z;

    // Trellis bounds
    const minX = trellisX - t.width / 2;
    const maxX = trellisX + t.width / 2;
    const minY = trellisY;
    const maxY = trellisY + t.height;

    // Clamp position to trellis bounds for projection
    const clampedX = Math.max(minX, Math.min(maxX, position.x));
    const clampedY = Math.max(minY, Math.min(maxY, position.y));

    // Find nearest horizontal line (Y = constant)
    const nearestHLineY = Math.round((clampedY - minY) / t.spacing) * t.spacing + minY;
    const finalHLineY = Math.max(minY, Math.min(maxY, nearestHLineY));

    // Find nearest vertical line (X = constant)
    const nearestVLineX = Math.round((clampedX - minX) / t.spacing) * t.spacing + minX;
    const finalVLineX = Math.max(minX, Math.min(maxX, nearestVLineX));

    // Point on nearest horizontal line (X can vary along the line)
    const pointOnHLine = new THREE.Vector3(clampedX, finalHLineY, trellisZ);

    // Point on nearest vertical line (Y can vary along the line)
    const pointOnVLine = new THREE.Vector3(finalVLineX, clampedY, trellisZ);

    // Return whichever is closer
    const distH = position.distanceTo(pointOnHLine);
    const distV = position.distanceTo(pointOnVLine);

    return distH < distV ? pointOnHLine : pointOnVLine;
  }

  /**
   * Calculate the force vector toward the nearest trellis point
   * @param {THREE.Vector3} position Current section position
   * @param {number} radius Current section radius
   * @returns {{ direction: THREE.Vector3, strength: number } | null}
   */
  calculateTrellisForce(position, radius) {
    const trellis = this.options.trellis;
    const nearestPoint = this.getNearestTrellisPoint(position);

    const distance = position.distanceTo(nearestPoint);

    // Only apply force within max distance
    if (distance > trellis.force.maxDistance) return null;
    if (distance < 0.001) return null; // Avoid division by zero

    // Calculate direction toward trellis
    const direction = new THREE.Vector3()
      .subVectors(nearestPoint, position)
      .normalize();

    // Calculate strength with distance falloff
    // Closer = stronger force, scaled by inverse radius (like existing force)
    const distanceFactor = 1 - Math.pow(
      distance / trellis.force.maxDistance,
      trellis.force.falloff,
    );
    const strength = trellis.force.strength * distanceFactor / radius;

    return { direction, strength };
  }

  get vertexCount() {
    return (this.branches.verts.length + this.leaves.verts.length) / 3;
  }

  get triangleCount() {
    return (this.branches.indices.length + this.leaves.indices.length) / 3;
  }
}
