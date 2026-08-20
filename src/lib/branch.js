import * as THREE from 'three';

export class Branch {
  /**
   * Generates a new branch
   * @param {THREE.Vector3} origin The starting point of the branch
   * @param {THREE.Euler} orientation The starting orientation of the branch
   * @param {number} length The length of the branch
   * @param {number} radius The radius of the branch at its starting point
   * @param {number} level The recursion level of this branch (0 = trunk)
   * @param {number} sectionCount Number of sections along this branch
   * @param {number} segmentCount Number of radial segments
   * @param {string} path Stable address of this branch in the tree, e.g.
   *   "0" (trunk), "0.2" (3rd child of the trunk), "0c" (tip continuation of
   *   the trunk). Used for per-branch overrides and picking.
   * @param {RNG|null} rng Independent RNG stream for this branch (perBranch
   *   mode). null when using the shared tree RNG (shared mode).
   */
  constructor(
    origin = new THREE.Vector3(),
    orientation = new THREE.Euler(),
    length = 0,
    radius = 0,
    level = 0,
    sectionCount = 0,
    segmentCount = 0,
    path = '0',
    rng = null,
  ) {
    this.origin = origin.clone();
    this.orientation = orientation.clone();
    this.length = length;
    this.radius = radius;
    this.level = level;
    this.sectionCount = sectionCount;
    this.segmentCount = segmentCount;
    this.path = path;
    this.rng = rng;
  }
}
