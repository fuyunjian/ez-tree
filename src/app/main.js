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
    // Update time for wind sway shaders
    const t = clock.getElapsedTime();
    tree.update(t);
    scene.getObjectByName('Forest').children.forEach((o) => o.update(t));
    environment.update(t);

    controls.update();
    composer.render();
    requestAnimationFrame(animate);
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

  renderer.domElement.addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    // Ignore drags (camera orbit) — only treat near-stationary left clicks as picks.
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObject(tree.branchesMesh, false);
    if (hits.length > 0 && hits[0].face) {
      const attr = tree.branchesMesh.geometry.attributes.aBranchIndex;
      if (attr) {
        const idx = attr.getX(hits[0].face.a);
        ui.selectBranch(idx);
        return;
      }
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