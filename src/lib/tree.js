import * as THREE from 'three';
import RNG from './rng';
import { Branch } from './branch';
import { Billboard, TreeType } from './enums';
import TreeOptions from './options';
import { loadPreset } from './presets/index';
import { Trellis } from './trellis';

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

    // Create the trunk of the tree first
    this.branchQueue.push(
      new Branch(
        new THREE.Vector3(),
        new THREE.Euler(),
        this.options.branch.length[0],
        this.options.branch.radius[0],
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
      (this.options.type === 'Deciduous' ? this.options.branch.levels - 1 : 1);

    // This information is used for generating child branches after the branch
    // geometry has been constructed
    let sections = [];

    // RNG stream for this branch: its own (perBranch) or the shared tree
    // stream (legacy). Using a local keeps the consumption order identical
    // in both modes, so trees stay seed-exact in 'shared'.
    const rng = this.options.rngMode === 'perBranch' ? branch.rng : this.rng;

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
        this.#branchParam(branch, 'gnarliness', this.options.branch.gnarliness[branch.level]);

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
    });

    // Stage B: sprout exposed root fingers from the trunk base. Runs only for
    // the trunk and only when roots > 0. Uses a dedicated RNG so it never
    // perturbs the main generation stream.
    if (butt && butt.roots > 0) {
      this.#generateRoots(sections, butt);
    }

    // Deciduous trees have a terminal branch that grows out of the
    // end of the parent branch
    if (this.options.type === 'deciduous') {
      const lastSection = sections[sections.length - 1];

      if (branch.level < this.options.branch.levels) {
        const tipPath = branch.path + 'c';
        const tipOv = (this.options.branch.overrides && this.options.branch.overrides[tipPath]) || {};
        const tipLength = tipOv.length ?? this.options.branch.length[branch.level + 1];
        const tipSections = tipOv.sections ?? branch.sectionCount;
        const tipSegments = tipOv.segments ?? branch.segmentCount;
        const tipRng = this.options.rngMode === 'perBranch' ? this.#makeRng(tipPath) : null;
        this.branchQueue.push(
          new Branch(
            lastSection.origin,
            lastSection.orientation,
            tipLength,
            lastSection.radius,
            branch.level + 1,
            tipSections,
            tipSegments,
            tipPath,
            tipRng,
          ),
        );
      } else {
        this.#recordLeaf(lastSection.origin, lastSection.orientation, rng);
      }
    }

    // If we are on the last branch level, generate leaves
    const leavesLevel = Math.min(
      this.options.leaves.level ?? this.options.branch.levels,
      this.options.branch.levels,
    );

    if (branch.level < this.options.branch.levels) {
      this.generateChildBranches(
        this.#branchChildren(branch),
        branch.level + 1,
        sections,
        rng,
        branch.path,
      );
      if (branch.level >= leavesLevel) {
        this.generateLeaves(sections, rng, branchLength);
      }
    } else {
      this.generateLeaves(sections, rng, branchLength);
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
      const childBranchRadius =
        this.options.branch.radius[level] *
        ((1 - alpha) * sectionA.radius + alpha * sectionB.radius);

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
          : 1.0);

      this.branchQueue.push(
        new Branch(
          childBranchOrigin,
          childBranchOrientation,
          childBranchLength,
          childBranchRadius,
          level,
          childOv.sections ?? this.options.branch.sections[level],
          childOv.segments ?? this.options.branch.segments[level],
          childPath,
          usePerBranch ? childRng : null,
        ),
      );
    }
  }

  /**
   * Logic for spawning child branches from a parent branch's section
   * @param {{
   *  origin: THREE.Vector3,
   *  orientation: THREE.Euler,
   *  radius: number
   * }[]} sections The parent branch's sections
   * @returns
   */
  generateLeaves(sections, rng, branchLength) {
    const radialOffset = rng.random();
    const baseCount = this.options.leaves.count;

    // Density: scale the leaf count with this branch's length relative to the
    // trunk so long branches stay well covered on large trees. density = 0
    // leaves the count unchanged (legacy behavior).
    const density = this.options.leaves.density || 0;
    const factor = Math.max(0.1, 1 + density * (branchLength / (this.trunkLength || 1) - 1));
    const count = Math.max(1, Math.round(baseCount * factor));

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

      this.#recordLeaf(leafOrigin, leafOrientation, rng);
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
  #generateRoots(sections, butt) {
    const base = sections[0];
    if (!base) return;
    const rrng = this.#makeRng(base.path + ':buttress-roots');
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
        path: base.path + '.root' + k,
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
  */
  #recordLeaf(origin, orientation, rng) {
    const size =
      this.options.leaves.size *
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
        radius: slabOpts.radius * (1 + rng.random(slabOpts.radiusVariance, -slabOpts.radiusVariance)),
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

      // Create the segments that make up this section.
      let first;
      for (let j = 0; j < segments; j++) {
        let angle = (2.0 * Math.PI * j) / segments;

        // Effective radius after the buttress flute modulation.
        const rEff = buttFade > 0
          ? section.radius * (1 + butt.strength * buttFade * Math.cos(butt.flutes * angle - butt.phase))
          : section.radius;

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
