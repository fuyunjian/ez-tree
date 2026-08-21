import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { setupUI } from './ui';
import { createScene } from './scene';

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('app')

  // User needs to interact with the page before audio will play
  container.addEventListener('click', toggleAudio);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setClearColor(0);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 2;
  container.appendChild(renderer.domElement);

  const { scene, environment, tree, camera, controls } = await createScene(renderer);

  const composer = new EffectComposer(renderer);

  composer.addPass(new RenderPass(scene, camera));

  const smaaPass = new SMAAPass(
    container.clientWidth * renderer.getPixelRatio(),
    container.clientHeight * renderer.getPixelRatio());
  composer.addPass(smaaPass);

  composer.addPass(new OutputPass());

  const clock = new THREE.Clock();
  function animate() {
    // Schedule the next frame FIRST so a render error can never permanently
    // freeze the UI (previously requestAnimationFrame sat after composer.render,
    // so any throw here stopped the loop for good).
    requestAnimationFrame(animate);
    try {
      // Update time for wind sway shaders
      const dt = clock.getDelta();
      const t = clock.elapsedTime;
      // Drive the growth animation playback clock (no-op unless playing).
      ui.tickGrowth?.(dt);
      tree.update(t);
      scene.getObjectByName('Forest').children.forEach((o) => o.update(t));
      environment.update(t);

      controls.update();
      composer.render();
    } catch (err) {
      // Keep the loop alive; surface the error for debugging instead of freezing.
      console.error('Render loop error (frame skipped):', err);
    }
  }

  function resize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    smaaPass.setSize(container.clientWidth, container.clientHeight);
    composer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', resize);

  const ui = setupUI(tree, environment, renderer, scene, camera, controls, 'Ash Medium');
  animate();
  resize();

  // ----- Click-to-select a branch for individual editing -----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downX = 0, downY = 0;

  /** Ray-picks the branches mesh. Returns {index, point} or null. */
  function pickBranch(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(tree.branchesMesh, false);
    if (hits.length > 0 && hits[0].face) {
      const attr = tree.branchesMesh.geometry.attributes.aBranchIndex;
      if (attr) {
        return { index: attr.getX(hits[0].face.a), point: hits[0].point };
      }
    }
    return null;
  }

  // ----- Right-click: add a custom branch at the clicked spot -----
  const addDialog = document.createElement('div');
  addDialog.className = 'overlay';
  addDialog.innerHTML = `
    <div class="about-dialog">
      <h2 style="margin-top:0">是否在此添加枝干？</h2>
      <p id="add-branch-info" style="opacity:0.85;white-space:pre-line;margin:16px 0 0"></p>
      <div class="dialog-buttons">
        <button class="close-button" id="add-branch-cancel">取消</button>
        <button class="close-button primary" id="add-branch-confirm">添加</button>
      </div>
    </div>`;
  document.body.appendChild(addDialog);

  function hideAddDialog() {
    addDialog.classList.remove('active');
  }

  let pendingAdd = null;

  addDialog.querySelector('#add-branch-cancel').addEventListener('click', () => {
    pendingAdd = null;
    hideAddDialog();
  });
  addDialog.addEventListener('click', (e) => {
    if (e.target === addDialog) {
      pendingAdd = null;
      hideAddDialog();
    }
  });
  addDialog.querySelector('#add-branch-confirm').addEventListener('click', () => {
    hideAddDialog();
    if (!pendingAdd) return;
    const { index, t, radialAngle } = pendingAdd;
    pendingAdd = null;
    const ub = tree.addUserBranch(index, t, radialAngle);
    if (!ub) return;
    ui.regenerate();
    const path = `${ub.parentPath}@u${ub.id}`;
    const idx = tree.skeleton.branches.findIndex((b) => b.path === path);
    if (idx >= 0) ui.selectBranch(idx);
  });

  renderer.domElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = pickBranch(e);
    if (!hit) return;
    const attach = tree.getBranchAttachFromPoint(hit.index, hit.point);
    if (!attach) return;
    const sb = tree.skeleton.branches[hit.index];
    pendingAdd = { index: hit.index, t: attach.t, radialAngle: attach.radialAngle };
    addDialog.querySelector('#add-branch-info').textContent =
      `父枝：${sb.path}（第 ${sb.level} 级）\n挂点：父枝长度的 ${(attach.t * 100).toFixed(0)}% 处`;
    addDialog.classList.add('active');
  });

  // ----- Drag a user-placed branch to slide it along its parent -----
  let dragUser = null;
  let lastDragRegen = 0;

  /**
   * Maps the pointer to a position t (0..1) along a parent branch by
   * projecting its skeleton sections to screen space and finding the
   * closest point on the projected polyline. Keeps the dragged branch
   * under the cursor while it slides along its parent.
   */
  function screenTAlongBranch(e, parentSb) {
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pts = parentSb.sections.map((s) => {
      const v = s.origin.clone().project(camera);
      return {
        x: ((v.x + 1) / 2) * rect.width,
        y: ((1 - v.y) / 2) * rect.height,
      };
    });
    let best = { d: Infinity, t: 0.5 };
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      const len2 = dx * dx + dy * dy;
      const alpha = len2 > 1e-6
        ? Math.max(0, Math.min(1, ((mx - pts[i].x) * dx + (my - pts[i].y) * dy) / len2))
        : 0;
      const px = pts[i].x + alpha * dx;
      const py = pts[i].y + alpha * dy;
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < best.d) best = { d, t: (i + alpha) / (pts.length - 1) };
    }
    return best.t;
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
    if (e.button !== 0) return;

    // Pressing directly on a user-placed branch arms drag-to-move. A
    // stationary press still behaves like a normal click (see pointerup).
    const hit = pickBranch(e);
    if (hit) {
      const sb = tree.skeleton?.branches?.[hit.index];
      if (sb && sb.user) {
        dragUser = {
          index: hit.index,
          path: sb.path,
          parentPath: sb.user.parentPath,
          moved: false,
        };
        controls.enabled = false;
      }
    }
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!dragUser) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 5) return;
    dragUser.moved = true;

    const parentSb = tree.skeleton?.branches?.find(
      (b) => b.path === dragUser.parentPath);
    if (!parentSb) return;

    tree.moveUserBranch(dragUser.path, { t: screenTAlongBranch(e, parentSb) });

    // Throttled live regeneration so the branch visibly slides along its
    // parent while dragging.
    const now = performance.now();
    if (now - lastDragRegen > 120) {
      lastDragRegen = now;
      ui.regenerate();
    }
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (dragUser) {
      const wasMoved = dragUser.moved;
      const idx = dragUser.index;
      dragUser = null;
      controls.enabled = true;
      if (wasMoved) {
        ui.regenerate();
        ui.selectBranch(idx);
        return;
      }
      // Stationary press: fall through to normal click-to-select.
    }

    // Ignore drags (camera orbit) — only treat near-stationary left clicks as picks.
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;

    const hit = pickBranch(e);
    if (hit) {
      // Decal mode: spray a decal at the clicked surface point (takes
      // precedence over paste mode / branch selection).
      if (ui.isDecalMode && ui.isDecalMode()) {
        // Re-raycast to obtain the hit face normal (pickBranch drops it).
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const decalHits = raycaster.intersectObject(tree.branchesMesh, false);
        const dh = decalHits[0];
        if (dh && dh.face) {
          const worldNormal = dh.face.normal.clone()
            .transformDirection(tree.branchesMesh.matrixWorld)
            .normalize();
          const added = tree.addDecalAt(dh.point, worldNormal, {
            dataURL: ui.getDecalDataURL(),
            size: ui.getDecalSize(),
          });
          if (added) ui.toast('已喷绘贴花');
        }
        return;
      }
      // Paste mode: the next clicked branch becomes the new parent of the
      // copied subtree (re-parented, scaled by parent radius).
      if (ui.isPasteArmed() && ui.getClipboard()) {
        const template = ui.getClipboard();
        const created = tree.pasteBranch(hit.index, template);
        ui.disarmPaste();
        if (created && created.length) {
          ui.toast('已粘贴枝干（粘到更细的枝上会自动缩小）');
          ui.regenerate().then(() => {
            const idx = tree.skeleton.branches.findIndex((b) => b.path === created[0]);
            if (idx >= 0) ui.selectBranch(idx);
          });
        } else {
          ui.toast('粘贴失败');
        }
        return;
      }
      ui.selectBranch(hit.index);
      return;
    }
    ui.selectBranch(null);
  });

  document.getElementById('audio-status').style.display = 'block';
});

window.toggleAudio = function () {
  document.getElementById('app').removeEventListener('click', toggleAudio);

  if (window.isAudioPlaying) {
    window.isAudioPlaying = false;
    document.getElementById('audio-status').src = "/icons/icon_muted.png";
    document.getElementById('background-audio').pause();
  } else {
    window.isAudioPlaying = true;
    document.getElementById('audio-status').src = "/icons/icon_playing.png";
    document.getElementById('background-audio').play();
  }
}