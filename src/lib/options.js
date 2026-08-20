import { Billboard, TreeType } from './enums';

export default class TreeOptions {
  constructor() {
    this.seed = 0;
    this.type = TreeType.Deciduous;

    // RNG mode for branch generation:
    //   'shared'    — one RNG stream for the whole tree (legacy behavior,
    //                 seed-exact). Changing one branch still perturbs every
    //                 branch that grows afterwards.
    //   'perBranch' — each branch gets its own RNG seeded from its path, so
    //                 editing one branch never disturbs its siblings. This is
    //                 what makes per-branch overrides truly local.
    this.rngMode = 'shared';

    // Bark parameters
    this.bark = {
      // Informational identifier carried through presets. The library does not
      // consume this field; the host app uses it to resolve which texture set
      // to assign to `maps` below.
      type: 'Bark001',

      // Texture maps supplied by the caller. Each entry is a THREE.Texture or
      // null. When `textured` is true, non-null maps are applied to the
      // material; null maps fall back to the tint color for that channel.
      maps: {
        color: null,
        ao: null,
        normal: null,
        roughness: null,
      },

      // Tint of the tree trunk
      tint: 0xffffff,

      // Use face normals for shading instead of vertex normals
      flatShading: false,

      // Apply texture to bark
      textured: true,

      // Scale for the texture
      textureScale: { x: 1, y: 1 },
    };

    // Branch parameters
    this.branch = {
      // Number of branch recursion levels. 0 = trunk only
      levels: 3,

      // Angle of the child branches relative to the parent branch (degrees)
      angle: {
        1: 70,
        2: 60,
        3: 60,
      },

      // Number of children per branch level
      children: {
        0: 7,
        1: 7,
        2: 5,
      },

      // External force encouraging tree growth in a particular direction
      force: {
        direction: { x: 0, y: 1, z: 0 },
        strength: 0.01,
      },

      // Amount of curling/twisting at each branch level
      gnarliness: {
        0: 0.15,
        1: 0.2,
        2: 0.3,
        3: 0.02,
      },

      // Length of each branch level
      length: {
        0: 20,
        1: 20,
        2: 10,
        3: 1,
      },

      // Radius of each branch level
      radius: {
        0: 1.5,
        1: 0.7,
        2: 0.7,
        3: 0.7,
      },

      // Number of sections per branch level
      sections: {
        0: 12,
        1: 10,
        2: 8,
        3: 6,
      },

      // Number of radial segments per branch level
      segments: {
        0: 8,
        1: 6,
        2: 4,
        3: 3,
      },

      // Defines where child branches start forming on the parent branch
      start: {
        1: 0.4,
        2: 0.3,
        3: 0.3,
      },

      // Taper at each branch level
      taper: {
        0: 0.7,
        1: 0.7,
        2: 0.7,
        3: 0.7,
      },

      // Amount of twist at each branch level
      twist: {
        0: 0,
        1: 0,
        2: 0,
        3: 0,
      },

      // Per-branch overrides, keyed by the branch path (see Branch.path,
      // e.g. "0", "0.2", "0c"). Any key present here wins over the
      // level-based values above for that single branch only. Supported
      // keys: length, radius, angle, children, gnarliness, taper, twist,
      // sections, segments, start, force ({direction,strength}), curve
      // ([{t,dir:{x,y,z},strength}]).
      overrides: {},

      // User-placed custom branches, added from the app by right-clicking a
      // spot on an existing branch. Each entry: { id, parentPath, t,
      // radialAngle } where parentPath addresses the parent branch, t is the
      // attachment point along the parent (0..1) and radialAngle the angle
      // around the parent's axis (radians). The attach point is re-derived
      // from the parent's skeleton on every generate(), so the branch stays
      // snapped to its parent while t/radialAngle are editable (sliding /
      // rotating). Paths look like "0.2@u1" and accept normal overrides.
      userBranches: [],

      // Cap the open ends of branches with a triangle fan (dead/snapped
      // branches, exposed root tips, user branches). The trunk base is also
      // capped so it never shows a hole at ground level.
      capEnds: true,
    };

    // Leaf parameters
    this.leaves = {
      // Informational identifier (e.g. 'oak', 'ash'). Library does not consume
      // it; the host app uses it to resolve which texture to assign to `map`.
      type: 'oak',

      // Color map supplied by the caller. THREE.Texture or null.
      // When null, leaves render as a flat tinted quad.
      map: null,

      // Whether to use single or double/perpendicular billboards
      billboard: Billboard.Double,

      // Angle of leaves relative to parent branch (degrees)
      angle: 10,

      // Number of leaves
      count: 1,

      // Lowest branch level that sprouts leaves (inclusive). Defaults to the
      // last level so only terminal branches carry leaves (legacy behavior).
      // Lowering it makes every branch at or below that level grow leaves,
      // which fills the canopy on large trees.
      level: 3,

      // Extra leaves per unit of branch length, as a fraction. 0 = legacy
      // (fixed count). Raising it scales a branch's leaf count up with its
      // length so long branches stay well covered.
      density: 0,

      // Where leaves start to grow on the length of the branch (0 to 1)
      start: 0,

      // Size of the leaves
      size: 2.5,

      // Variance in leaf size between each instance
      sizeVariance: 0.7,

      // Tint color for the leaves
      tint: 0xffffff,

      // Controls transparency of leaf texture
      alphaTest: 0.5,

      // Calculates custom normals to imply a rounded canopy shape
      roundedNormals: true,

      // Cloud-slab foliage (云片叶簇, stage C). When enabled, each leaf
      // placement becomes a flat horizontal foliage cluster instead of the
      // default billboard quad. The cluster is `layers` stacked horizontal
      // discs (triangle fans) in the local XZ plane, slightly offset in Y so
      // it reads as a layered "cloud slab" puff — the signature canopy of an
      // ancient cypress (古柏) like the Zhang-Fei-bai. Placement (which
      // branches carry foliage, how many, density) is still driven by the
      // leaf controls above (count / level / density / start); this block
      // only controls the slab geometry.
      slab: {
        enabled: false, // replaces billboard leaves with cloud-slab foliage
        radius: 5, // horizontal radius of one slab cluster (world units)
        thickness: 1.5, // vertical spacing/thickness of each stacked layer
        layers: 3, // number of stacked horizontal sheets per cluster
        tilt: 12, // max random tilt off horizontal, in degrees
        segments: 12, // radial subdivisions of each disc
        radiusVariance: 0.3, // per-cluster random radius jitter (0..1)
      },
    };

    // Trunk sculpting (stage A). Affects level-0 branches (the trunk) only.
    // Lets you bulge the base, bow the midsection, twist it, and add surface
    // noise so a procedural trunk reads as an ancient tree rather than a
    // smooth cone.
    this.trunk = {
      enabled: true,
      bottomSwell: 1, // base radius multiplier (1 = none, 1.8 = 80% wider base)
      swellHeight: 0.25, // fraction of trunk height over which the swell fades to 1
      bow: 0, // midsection lateral bow (world units at the peak)
      bowHeight: 0.5, // normalized height (0..1) where the bow peaks
      bowDirection: 0, // direction of the bow in radians (0 = +X)
      twist: 0, // trunk twist in radians across the full trunk height
      noise: 0, // surface noise strength (vertical furrows / bumps)

      // Stage B: buttress roots / exposed root system (板根/外露根系).
      // Affects level-0 (trunk) base only. `flutes` carves N radial ridges
      // into the lower trunk (the classic 板根 flare); `roots` sprouts
      // tapering root fingers that radiate outward and dive downward from the
      // base (外露根系). Both fade with height so the effect stays at the foot
      // of the tree. Disabled by default (roots: 0) so legacy trees are
      // untouched.
      buttress: {
        enabled: false, // master switch for stage B
        flutes: 5, // number of radial buttress ridges around the trunk
        strength: 0.35, // ridge depth (0..1 of the base radius)
        height: 0.3, // fraction of trunk height the ridges extend up
        phase: 0, // angular offset of the ridges (radians)
        roots: 0, // number of exposed root fingers (0 = none)
        rootLength: 6, // how far roots spread along the ground (world units)
        rootDepth: 2, // how deep roots dive below ground (world units)
        rootWidth: 0.6, // root base width as a fraction of the trunk base radius
      },

      // Stage D: deadwood (枯枝与空洞). Hollows and cracks affect the trunk
      // (level 0) only, carving a localized inward dent and vertical fissures
      // into the bark. deadBranchChance applies to ALL non-trunk child
      // branches: a branch that rolls "dead" grows shorter, thinner, more
      // twisted, and carries no leaves or children — a bare snapped twig.
      // Disabled by default so legacy trees are untouched.
      deadwood: {
        enabled: false,
        hollowStrength: 0.5, // depth of the hollow (fraction of radius, 0..1)
        hollowHeight: 0.3, // normalized trunk height (0..1) of the hollow center
        hollowWidth: 0.25, // angular half-width of the hollow (radians)
        hollowPhase: 0, // angular position of the hollow (radians)
        crackCount: 0, // number of vertical cracks (0 = none)
        crackDepth: 0.15, // crack depth (fraction of radius, 0..0.5)
        crackWidth: 0.06, // angular half-width of each crack (radians)
        crackPhase: 0, // angular offset of the crack pattern (radians)
        deadBranchChance: 0, // probability a child branch is dead (0..1)
        deadBranchLength: 0.6, // length multiplier for dead branches (shorter = snapped)
      },
    };

    // Global pose (stage E). Applied per-section, scaled by the section's
    // world height, so the WHOLE tree leans / spirals / grows asymmetrically
    // coherently instead of each branch doing it independently.
    this.global = {
      enabled: true,
      lean: { x: 0, z: 0 }, // tilt in radians per unit world height
      twist: 0, // spiral in radians per unit world height
      asymmetry: { x: 0, z: 0 }, // constant directional growth bias (like wind)
    };

    // Trellis parameters
    this.trellis = {
      // Whether trellis is enabled
      enabled: false,

      // Position of trellis (z is distance from tree)
      position: { x: 0, y: 0, z: -2 },

      // Width of trellis grid (X direction)
      width: 10,

      // Height of trellis grid (Y direction)
      height: 20,

      // Distance between grid lines
      spacing: 2,

      // Force parameters
      force: {
        // How strongly branches bend toward trellis
        strength: 0.02,
        // Maximum distance at which trellis affects branches
        maxDistance: 3,
        // Distance falloff exponent (1 = linear, 2 = quadratic)
        falloff: 1,
      },

      // Radius of trellis cylinders
      cylinderRadius: 0.05,

      // Whether to show trellis geometry
      visible: true,

      // Color of trellis
      color: 0x8b4513,
    };
  }

  /**
   * Copies the values from source into this object
   * @param {TreeOptions} source 
   */
  copy(source, target = this) {
    for (let key in source) {
      if (source.hasOwnProperty(key) && target.hasOwnProperty(key)) {
        const value = source[key];
        // Assign THREE.Texture (and any non-plain object) by reference rather
        // than recursing — recursion would walk a Texture's internals.
        if (value !== null && typeof value === 'object' && value.constructor === Object) {
          this.copy(value, target[key]);
        } else {
          target[key] = value;
        }
      }
    }
  }
}