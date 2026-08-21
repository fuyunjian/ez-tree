/**
 * Growth animation controller (树苗 → 大树).
 *
 * The user exports TWO parameter files from the app — "small tree.json" and
 * "big tree.json". This controller interpolates between them and produces a
 * full TreeOptions snapshot for any progress t ∈ [0,1].
 *
 * Design (user-confirmed):
 *  - The BIG tree provides the final STRUCTURE: branch.levels, user branches,
 *    per-branch overrides, bark/leaf textures, decals, seed, RNG mode.
 *  - The SMALL tree provides only "young" NUMERIC parameters: per-level
 *    length / radius / children / angles, leaf count / density / size, and
 *    the overall scale.
 *  - tree.js additionally gates branch birth by level windows (options.growth)
 *    so the animation reads as trunk → branches → twigs, with leaves present
 *    from the start and ramping up.
 *
 * Nothing here touches THREE.* — it works on plain JSON objects, so it can
 * run headless (Node probes) and in the browser alike.
 */

/** Per-level branch params that lerp small→big. */
const LEVEL_NUMERIC_KEYS = [
  'length', 'radius', 'angle', 'gnarliness', 'taper', 'twist',
  'sections', 'segments', 'start',
];

/** Leaf params that lerp small→big. */
const LEAF_NUMERIC_KEYS = [
  'count', 'density', 'size', 'sizeVariance', 'angle', 'start',
];

/** Smooth 0→1 ease used on the parameter interpolation. */
function ease(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

export class GrowthController {
  /**
   * @param {{ onChange?: (snapshot: object) => any }} [opts]
   *  `onChange` fires with a fresh snapshot whenever the caller must rebuild
   *  the tree (the app regenerates through its own coalesced onChange).
   */
  constructor(opts = {}) {
    this.onChange = opts.onChange || null;
    this.small = null;   // parsed "small tree" JSON (young params)
    this.big = null;     // parsed "big tree" JSON (structure + target params)
    this.progress = 0;   // 0..1 along the timeline
    this.playing = false;
    this.loop = false;
    this.duration = 12000; // ms for one full 0→1 pass
  }

  /** Parses + stores the small-tree JSON. */
  setSmall(json) {
    this.small = json && typeof json === 'object' ? json : null;
  }

  /** Parses + stores the big-tree JSON (required to play). */
  setBig(json) {
    this.big = json && typeof json === 'object' ? json : null;
  }

  clear() {
    this.small = null;
    this.big = null;
    this.progress = 0;
    this.playing = false;
  }

  get ready() {
    return !!this.big;
  }

  /**
   * Builds the full options snapshot at progress t ∈ [0,1].
   * @param {number} t 0..1
   * @returns {object|null} plain snapshot (or null if no big tree loaded)
   */
  snapshotAt(t) {
    const big = this.big;
    if (!big) return null;
    const small = this.small || this.#inferSmall(big);
    const p = Math.min(1, Math.max(0, t));
    const e = ease(p);

    // Structure comes from the big tree, wholesale.
    const snap = structuredClone(big);

    // Drive the level-window gating inside tree.js.
    snap.growth = { enabled: true, progress: p };

    // Per-level numeric params lerp small → big.
    const bb = big.branch || {};
    const sb = (small && small.branch) || {};
    if (!snap.branch) snap.branch = {};
    for (const key of LEVEL_NUMERIC_KEYS) {
      const bd = bb[key];
      if (!bd || typeof bd !== 'object') continue;
      const sd = sb[key];
      const out = {};
      for (const k of Object.keys(bd)) {
        const bv = bd[k];
        const sv = sd ? sd[k] : undefined;
        out[k] = (typeof bv === 'number' && typeof sv === 'number')
          ? sv + (bv - sv) * e
          : bv;
      }
      snap.branch[key] = out;
    }

    // Children counts are integers (round the lerp).
    const bch = bb.children;
    const sch = sb.children;
    if (bch && typeof bch === 'object') {
      const out = {};
      for (const k of Object.keys(bch)) {
        const bv = bch[k];
        const sv = sch ? sch[k] : undefined;
        out[k] = (typeof bv === 'number' && typeof sv === 'number')
          ? Math.round(sv + (bv - sv) * e)
          : bv;
      }
      snap.branch.children = out;
    }

    // Leaf params lerp small → big (leaves are present the whole time).
    const bl = big.leaves || {};
    const sl = (small && small.leaves) || {};
    if (!snap.leaves) snap.leaves = {};
    for (const key of LEAF_NUMERIC_KEYS) {
      const bv = bl[key];
      const sv = sl[key];
      if (typeof bv === 'number' && typeof sv === 'number') {
        snap.leaves[key] = sv + (bv - sv) * e;
      }
    }

    // Overall scale lerps too (so the whole silhouette shrinks/grows).
    if (typeof big.scale === 'number' && typeof small.scale === 'number') {
      snap.scale = small.scale + (big.scale - small.scale) * e;
    }

    return snap;
  }

  /**
   * Advances the playback clock. Returns true when progress changed (the
   * caller decides how often to actually rebuild).
   * @param {number} dtMs elapsed milliseconds
   */
  tick(dtMs) {
    if (!this.playing || !this.big) return false;
    let next = this.progress + (dtMs || 0) / this.duration;
    if (next >= 1) {
      if (this.loop) {
        next = next % 1;
      } else {
        next = 1;
        this.playing = false;
      }
    }
    this.progress = next;
    return true;
  }

  play() {
    if (!this.big) return;
    if (this.progress >= 0.999) this.progress = 0;
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Jumps to an absolute progress (0..1), pausing playback. */
  seek(t) {
    this.playing = false;
    this.progress = Math.min(1, Math.max(0, t));
  }

  /**
   * When only the big tree is loaded, synthesize a plausible "young"
   * parameter set so the timeline still works for a quick preview.
   */
  #inferSmall(big) {
    const s = structuredClone(big);
    const bb = s.branch || {};
    for (const key of ['length', 'radius', 'angle', 'gnarliness', 'taper']) {
      const d = bb[key];
      if (d && typeof d === 'object') {
        for (const k of Object.keys(d)) {
          if (typeof d[k] === 'number') d[k] = d[k] * (key === 'length' ? 0.45 : key === 'radius' ? 0.6 : 1);
        }
      }
    }
    if (bb.children && typeof bb.children === 'object') {
      for (const k of Object.keys(bb.children)) {
        if (typeof bb.children[k] === 'number') {
          bb.children[k] = Math.max(1, Math.round(bb.children[k] * 0.4));
        }
      }
    }
    if (s.leaves) {
      if (typeof s.leaves.count === 'number') s.leaves.count = Math.max(1, Math.round(s.leaves.count * 0.35));
      if (typeof s.leaves.density === 'number') s.leaves.density *= 0.5;
    }
    if (typeof s.scale === 'number') s.scale *= 0.6;
    return s;
  }
}
