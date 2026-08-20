import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { zipSync } from 'three/addons/libs/fflate.module.js';
import { Billboard, TreePreset, Tree, TreeType } from '@dgreenheck/ez-tree';
import { BarkType, LeafType, applyTreeTextures, loadPresetWithTextures } from './textures';
import { Environment } from './environment';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { version } from '../../package.json';

const exporter = new GLTFExporter();

// ============================================================================
// Heroicons (outline style)
// ============================================================================

const icons = {
  // Tab icons
  tree: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-6m0 0l-3-3m3 3l3-3m-3-3V3m0 9l-4-4m4 4l4-4" />
  </svg>`,

  archive: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
  </svg>`,

  // Section icons
  swatch: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4.098 19.902a3.75 3.75 0 0 0 5.304 0l6.401-6.402M6.75 21A3.75 3.75 0 0 1 3 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 0 0 3.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008Z" />
  </svg>`,

  cube: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
  </svg>`,

  share: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
  </svg>`,

  sparkles: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
  </svg>`,

  videoCamera: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
  </svg>`,

  sun: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
  </svg>`,

  info: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
  </svg>`,

  folder: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
  </svg>`,

  cubeTransparent: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="m21 7.5-2.25-1.313M21 7.5v2.25m0-2.25-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3-2.25-1.313M12 12.75l2.25-1.313M12 12.75V15m0 6.75-2.25-1.313M12 21.75V19.5m0 2.25 2.25-1.313m0-16.875L12 2.25l-2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
  </svg>`,

  // Button icons
  dice: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 8.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v8.25A2.25 2.25 0 0 0 6 16.5h2.25m8.25-8.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-7.5A2.25 2.25 0 0 1 8.25 18v-1.5m8.25-8.25h-6a2.25 2.25 0 0 0-2.25 2.25v6" />
  </svg>`,

  document: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
  </svg>`,

  folderOpen: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
  </svg>`,

  download: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
  </svg>`,

  photo: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
  </svg>`,

  spinner: `<svg class="icon icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="12" cy="12" r="9" opacity="0.25" />
    <path stroke-linecap="round" d="M21 12a9 9 0 0 0-9-9" />
  </svg>`,

  // Arrow icon for sections
  chevronRight: `<svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
  </svg>`,

  chevronRightSmall: `<svg class="subsection-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
  </svg>`,

  chevronUp: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
  </svg>`,
};

// ============================================================================
// UI Component System
// ============================================================================

/**
 * Creates a slider control with label
 */
function createSlider(label, value, min, max, step, onChange) {
  const container = document.createElement('div');
  container.className = 'control-row';

  const labelEl = document.createElement('label');
  labelEl.className = 'control-label';
  labelEl.textContent = label;

  const sliderWrapper = document.createElement('div');
  sliderWrapper.className = 'slider-wrapper';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'slider';
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = value;

  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.className = 'slider-value';
  valueInput.value = formatValue(value, step);
  valueInput.step = step;

  // Fill the track up to the current value so it reads at a glance
  const setFill = () => {
    const pct = ((parseFloat(slider.value) - min) / (max - min || 1)) * 100;
    slider.style.setProperty('--fill', `${pct}%`);
  };
  setFill();

  slider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    valueInput.value = formatValue(val, step);
    setFill();
    onChange(val);
  });

  valueInput.addEventListener('change', (e) => {
    let val = parseFloat(e.target.value);
    if (isNaN(val)) val = min;
    slider.value = val;
    valueInput.value = formatValue(val, step);
    setFill();
    onChange(val);
  });

  sliderWrapper.appendChild(slider);
  sliderWrapper.appendChild(valueInput);
  container.appendChild(labelEl);
  container.appendChild(sliderWrapper);

  return {
    element: container,
    setValue: (v) => {
      slider.value = v;
      valueInput.value = formatValue(v, step);
      setFill();
    }
  };
}

function formatValue(value, step) {
  if (step >= 1) return Math.round(value).toString();
  const decimals = step.toString().split('.')[1]?.length || 2;
  return value.toFixed(Math.min(decimals, 3));
}

/**
 * Creates a color picker control
 */
function createColorPicker(label, value, onChange) {
  const container = document.createElement('div');
  container.className = 'control-row';

  const labelEl = document.createElement('label');
  labelEl.className = 'control-label';
  labelEl.textContent = label;

  const pickerWrapper = document.createElement('div');
  pickerWrapper.className = 'color-picker-wrapper';

  const colorPreview = document.createElement('div');
  colorPreview.className = 'color-preview';
  colorPreview.style.backgroundColor = '#' + value.toString(16).padStart(6, '0');

  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'color-picker';
  picker.value = '#' + value.toString(16).padStart(6, '0');

  picker.addEventListener('input', (e) => {
    const hex = parseInt(e.target.value.slice(1), 16);
    colorPreview.style.backgroundColor = e.target.value;
    onChange(hex);
  });

  pickerWrapper.appendChild(colorPreview);
  pickerWrapper.appendChild(picker);
  container.appendChild(labelEl);
  container.appendChild(pickerWrapper);

  return {
    element: container,
    setValue: (v) => {
      const hexStr = '#' + v.toString(16).padStart(6, '0');
      picker.value = hexStr;
      colorPreview.style.backgroundColor = hexStr;
    }
  };
}

/**
 * Creates a dropdown select control
 */
function createSelect(label, options, value, onChange) {
  const container = document.createElement('div');
  container.className = 'control-row';

  const labelEl = document.createElement('label');
  labelEl.className = 'control-label';
  labelEl.textContent = label;

  const selectWrapper = document.createElement('div');
  selectWrapper.className = 'select-wrapper';

  const select = document.createElement('select');
  select.className = 'select';

  Object.entries(options).forEach(([key, val]) => {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = key;
    if (val === value) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', (e) => {
    onChange(e.target.value);
  });

  selectWrapper.appendChild(select);
  container.appendChild(labelEl);
  container.appendChild(selectWrapper);

  return {
    element: container,
    setValue: (v) => { select.value = v; }
  };
}

/**
 * Creates a checkbox/toggle control
 */
function createToggle(label, value, onChange) {
  const container = document.createElement('div');
  container.className = 'control-row';

  const labelEl = document.createElement('label');
  labelEl.className = 'control-label';
  labelEl.textContent = label;

  const toggleWrapper = document.createElement('div');
  toggleWrapper.className = 'toggle-wrapper';

  const toggle = document.createElement('button');
  toggle.className = 'toggle' + (value ? ' active' : '');
  toggle.innerHTML = '<span class="toggle-knob"></span>';

  toggle.addEventListener('click', () => {
    const newValue = !toggle.classList.contains('active');
    toggle.classList.toggle('active', newValue);
    onChange(newValue);
  });

  toggleWrapper.appendChild(toggle);
  container.appendChild(labelEl);
  container.appendChild(toggleWrapper);

  return {
    element: container,
    setValue: (v) => {
      toggle.classList.toggle('active', v);
    }
  };
}

/**
 * Yields to the browser long enough for pending DOM updates to paint before
 * blocking work resumes on the main thread.
 */
function paint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );
}

/**
 * Creates a button.
 *
 * `onClick` is called with a `setStatus(text)` callback. If it returns a
 * promise, the button shows a spinner and stays disabled until it settles.
 */
function createButton(label, iconKey, onClick) {
  const button = document.createElement('button');
  button.className = 'panel-button';
  const setContent = (text, key) => {
    button.innerHTML = `${icons[key] || ''}<span>${text}</span>`;
  };
  setContent(label, iconKey);

  let statusSet = false;
  const setStatus = (text) => {
    statusSet = true;
    setContent(text, 'spinner');
  };

  button.addEventListener('click', () => {
    if (button.disabled) return;
    statusSet = false;
    const result = onClick({ setStatus });
    if (!result?.then) return;

    button.disabled = true;
    if (!statusSet) setStatus('处理中…');
    result.finally(() => {
      button.disabled = false;
      setContent(label, iconKey);
    });
  });
  return { element: button };
}

/**
 * Creates a read-only display
 */
function createDisplay(label, value, formatter = (v) => v) {
  const container = document.createElement('div');
  container.className = 'control-row display-row';

  const labelEl = document.createElement('label');
  labelEl.className = 'control-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'display-value';
  valueEl.textContent = formatter(value);

  container.appendChild(labelEl);
  container.appendChild(valueEl);

  return {
    element: container,
    setValue: (v) => { valueEl.textContent = formatter(v); }
  };
}

/**
 * Creates a collapsible section
 */
function createSection(title, iconKey, expanded = false) {
  const section = document.createElement('div');
  section.className = 'panel-section' + (expanded ? ' expanded' : '');

  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `
    ${icons[iconKey] || ''}
    <span class="section-title">${title}</span>
    ${icons.chevronRight}
  `;

  const contentWrap = document.createElement('div');
  contentWrap.className = 'section-content';

  const content = document.createElement('div');
  content.className = 'section-content-inner';
  contentWrap.appendChild(content);

  header.addEventListener('click', () => {
    section.classList.toggle('expanded');
  });

  section.appendChild(header);
  section.appendChild(contentWrap);

  return {
    element: section,
    content: content,
    add: (control) => content.appendChild(control.element || control),
    setExpanded: (exp) => section.classList.toggle('expanded', exp)
  };
}

/**
 * Creates a sub-section (nested within a section)
 */
function createSubSection(title, expanded = false) {
  const section = document.createElement('div');
  section.className = 'panel-subsection' + (expanded ? ' expanded' : '');

  const header = document.createElement('div');
  header.className = 'subsection-header';
  header.innerHTML = `
    <span class="subsection-title">${title}</span>
    ${icons.chevronRightSmall}
  `;

  const contentWrap = document.createElement('div');
  contentWrap.className = 'subsection-content';

  const content = document.createElement('div');
  content.className = 'subsection-content-inner';
  contentWrap.appendChild(content);

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    section.classList.toggle('expanded');
  });

  section.appendChild(header);
  section.appendChild(contentWrap);

  return {
    element: section,
    content: content,
    add: (control) => content.appendChild(control.element || control)
  };
}

// ============================================================================
// Main UI Setup
// ============================================================================

let controls = [];

// Index of the branch currently being edited individually (null = none).
// Declared early so every handler closure can read/write it.
let selectedIndex = null;
// Forward declaration; the real implementation is assigned after the
// Selected Branch section is built. Returns nothing.
let selectBranch = () => {};

/**
 * Setups the UI
 * @param {Tree} tree
 * @param {Environment} environment
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {OrbitControls} orbitControls
 * @param {String} initialPreset
 */
export function setupUI(tree, environment, renderer, scene, camera, orbitControls, initialPreset) {
  const container = document.getElementById('ui-container');
  container.innerHTML = '';
  controls = [];

  // Create main panel
  const panel = document.createElement('div');
  panel.className = 'custom-panel';
  panel.id = 'custom-panel';

  // Panel header with mobile toggle
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = `
    <div class="panel-grabber" aria-hidden="true"></div>
    <button class="panel-mobile-toggle" aria-label="切换面板">
      ${icons.chevronUp}
    </button>
    <h1 class="panel-title">EZ Tree</h1>
    <p class="panel-subtitle">程序化树木生成器</p>
  `;
  panel.appendChild(header);

  // Scrollable content area
  const scrollArea = document.createElement('div');
  scrollArea.className = 'panel-scroll-area';
  panel.appendChild(scrollArea);

  // Tab navigation
  const tabNav = document.createElement('div');
  tabNav.className = 'tab-nav';
  tabNav.innerHTML = `
    <button class="tab-button active" data-tab="parameters">
      ${icons.tree}
      <span class="tab-label">树木</span>
    </button>
    <button class="tab-button" data-tab="export">
      ${icons.archive}
      <span class="tab-label">导出</span>
    </button>
  `;
  scrollArea.appendChild(tabNav);

  const tabButtons = tabNav.querySelectorAll('.tab-button');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Parameters tab
  const parametersTab = document.createElement('div');
  parametersTab.className = 'tab-content active';
  parametersTab.id = 'tab-parameters';
  scrollArea.appendChild(parametersTab);

  // Export tab
  const exportTab = document.createElement('div');
  exportTab.className = 'tab-content';
  exportTab.id = 'tab-export';
  scrollArea.appendChild(exportTab);

  // ============================================================================
  // Stats Overlay (viewport HUD) with LOD preview switching
  // ============================================================================

  // The hero tree always generates at full detail; the LOD buttons re-mesh
  // its geometry at a chosen level via createGeometry() so it can be
  // inspected at any camera distance without THREE.LOD auto-switching.
  let previewLevel = 0;
  let lastBuildMs = null;

  const statsOverlay = document.createElement('div');
  statsOverlay.id = 'stats-overlay';
  statsOverlay.innerHTML = `
    <div class="stats-counts">
      <div class="stats-stat">
        <span class="stats-value" data-stat="triangles">0</span>
        <span class="stats-label">三角形</span>
      </div>
      <div class="stats-stat">
        <span class="stats-value" data-stat="vertices">0</span>
        <span class="stats-label">顶点</span>
      </div>
      <div class="stats-stat">
        <span class="stats-value" data-stat="buildtime">–</span>
        <span class="stats-label">构建耗时 (ms)</span>
      </div>
    </div>
    <div class="lod-switcher"></div>
  `;
  container.appendChild(statsOverlay);

  const statsTriangles = statsOverlay.querySelector('[data-stat="triangles"]');
  const statsVertices = statsOverlay.querySelector('[data-stat="vertices"]');
  const statsBuildTime = statsOverlay.querySelector('[data-stat="buildtime"]');

  /** Briefly highlights a stat value so live changes are visible */
  function pulseStat(el) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }

  const lodSwitcher = statsOverlay.querySelector('.lod-switcher');
  const lodButtons = Tree.defaultLODLevels.map((level, i) => {
    const btn = document.createElement('button');
    btn.className = 'lod-button' + (i === 0 ? ' active' : '');
    btn.textContent = i === 0 ? '完整' : `LOD${i}`;
    btn.title = i === 0
      ? '完整细节'
      : `预览细节等级 ${i}（在 ${level.distance} 单位距离切换）`;
    btn.addEventListener('click', () => setPreviewLevel(i));
    lodSwitcher.appendChild(btn);
    return btn;
  });

  function applyLODPreview() {
    const detail = Tree.defaultLODLevels[previewLevel]?.detail ?? {};
    const t0 = performance.now();
    const { branches, leaves } = tree.createGeometry(detail);
    lastBuildMs = performance.now() - t0;
    tree.branchesMesh.geometry.dispose();
    tree.branchesMesh.geometry = branches;
    tree.leavesMesh.geometry.dispose();
    tree.leavesMesh.geometry = leaves;
  }

  function setPreviewLevel(level) {
    previewLevel = level;
    lodButtons.forEach((b, i) => b.classList.toggle('active', i === level));
    applyLODPreview();
    updateInfoDisplays();
  }

  /** Vertex/triangle counts of the geometry currently on screen */
  function displayedCounts() {
    const gb = tree.branchesMesh.geometry;
    const gl = tree.leavesMesh.geometry;
    return {
      vertices: (gb.attributes.position?.count ?? 0) + (gl.attributes.position?.count ?? 0),
      triangles: ((gb.index?.count ?? 0) + (gl.index?.count ?? 0)) / 3,
    };
  }

  // ============================================================================
  // Parameters Tab Content
  // ============================================================================

  const onChange = () => {
    applyTreeTextures(tree);
    const t0 = performance.now();
    tree.generate();
    lastBuildMs = performance.now() - t0;
    if (previewLevel > 0) {
      applyLODPreview();
    }
    tree.traverse((o) => {
      if (o.material) {
        o.material.needsUpdate = true;
      }
    });
    // Keep the picked-branch highlight in sync after regeneration. If the
    // branch count changed (e.g. levels/children edited), an out-of-range
    // index auto-clears the highlight.
    if (selectedIndex != null) {
      tree.setSelectedBranch(selectedIndex);
    }

    // Update info displays
    updateInfoDisplays();
  };

  // ----- Presets Section -----
  const presetsSection = createSection('预设 (Presets)', 'swatch', true);

  const presetDisplayNames = {
    'Ash Small': '白蜡 小 (Ash Small)',
    'Ash Medium': '白蜡 中 (Ash Medium)',
    'Ash Large': '白蜡 大 (Ash Large)',
    'Aspen Small': '白杨 小 (Aspen Small)',
    'Aspen Medium': '白杨 中 (Aspen Medium)',
    'Aspen Large': '白杨 大 (Aspen Large)',
    'Bush 1': '灌木 1 (Bush 1)',
    'Bush 2': '灌木 2 (Bush 2)',
    'Bush 3': '灌木 3 (Bush 3)',
    'Oak Small': '橡树 小 (Oak Small)',
    'Oak Medium': '橡树 中 (Oak Medium)',
    'Oak Large': '橡树 大 (Oak Large)',
    'Pine Small': '松树 小 (Pine Small)',
    'Pine Medium': '松树 中 (Pine Medium)',
    'Pine Large': '松树 大 (Pine Large)',
    'Trellis': '藤架 (Trellis)',
  };
  const presetSelect = createSelect('预设',
    Object.fromEntries(Object.keys(TreePreset).map(p => [presetDisplayNames[p] || p, p])),
    initialPreset,
    (val) => {
      loadPresetWithTextures(tree, val);
      if (previewLevel > 0) {
        applyLODPreview();
      }
      selectBranch(null);
      refreshAllControls();
    }
  );
  presetsSection.add(presetSelect);
  controls.push({ control: presetSelect, update: () => {} });

  const seedSlider = createSlider('种子', tree.options.seed, 0, 65536, 1, (val) => {
    tree.options.seed = val;
    onChange();
  });
  presetsSection.add(seedSlider);
  controls.push({ control: seedSlider, update: () => seedSlider.setValue(tree.options.seed) });

  const randomSeedBtn = createButton('随机种子', 'dice', () => {
    tree.options.seed = Math.floor(Math.random() * 65536);
    seedSlider.setValue(tree.options.seed);
    onChange();
  });
  presetsSection.add(randomSeedBtn);

  parametersTab.appendChild(presetsSection.element);

  // ----- Bark Section -----
  const barkSection = createSection('树皮 (Bark)', 'cube', false);

  const barkTypeSelect = createSelect('类型', BarkType, tree.options.bark.type, (val) => {
    tree.options.bark.type = val;
    onChange();
  });
  barkSection.add(barkTypeSelect);
  controls.push({ control: barkTypeSelect, update: () => barkTypeSelect.setValue(tree.options.bark.type) });

  const barkTintPicker = createColorPicker('色调', tree.options.bark.tint, (val) => {
    tree.options.bark.tint = val;
    onChange();
  });
  barkSection.add(barkTintPicker);
  controls.push({ control: barkTintPicker, update: () => barkTintPicker.setValue(tree.options.bark.tint) });

  const flatShadingToggle = createToggle('平直着色', tree.options.bark.flatShading, (val) => {
    tree.options.bark.flatShading = val;
    onChange();
  });
  barkSection.add(flatShadingToggle);
  controls.push({ control: flatShadingToggle, update: () => flatShadingToggle.setValue(tree.options.bark.flatShading) });

  const texturedToggle = createToggle('启用纹理', tree.options.bark.textured, (val) => {
    tree.options.bark.textured = val;
    onChange();
  });
  barkSection.add(texturedToggle);
  controls.push({ control: texturedToggle, update: () => texturedToggle.setValue(tree.options.bark.textured) });

  const texScaleXSlider = createSlider('纹理缩放 X', tree.options.bark.textureScale.x, 0.5, 5, 0.1, (val) => {
    tree.options.bark.textureScale.x = val;
    onChange();
  });
  barkSection.add(texScaleXSlider);
  controls.push({ control: texScaleXSlider, update: () => texScaleXSlider.setValue(tree.options.bark.textureScale.x) });

  const texScaleYSlider = createSlider('纹理缩放 Y', tree.options.bark.textureScale.y, 0.5, 5, 0.1, (val) => {
    tree.options.bark.textureScale.y = val;
    onChange();
  });
  barkSection.add(texScaleYSlider);
  controls.push({ control: texScaleYSlider, update: () => texScaleYSlider.setValue(tree.options.bark.textureScale.y) });

  parametersTab.appendChild(barkSection.element);

  // ----- Branches Section -----
  const branchSection = createSection('枝干 (Branches)', 'share', false);

  const treeTypeSelect = createSelect('树木类型',
    { '落叶树 (Deciduous)': 'deciduous', '常绿树 (Evergreen)': 'evergreen' },
    tree.options.type, (val) => {
    tree.options.type = val;
    onChange();
  });
  branchSection.add(treeTypeSelect);
  controls.push({ control: treeTypeSelect, update: () => treeTypeSelect.setValue(tree.options.type) });

  const levelsSlider = createSlider('层级数', tree.options.branch.levels, 0, 3, 1, (val) => {
    tree.options.branch.levels = val;
    onChange();
  });
  branchSection.add(levelsSlider);
  controls.push({ control: levelsSlider, update: () => levelsSlider.setValue(tree.options.branch.levels) });

  const rngModeSelect = createSelect('随机数模式',
    { '每枝独立 (Per Branch)': 'perBranch', '全局共享 (Shared, 旧版)': 'shared' },
    tree.options.rngMode, (val) => {
    tree.options.rngMode = val;
    onChange();
  });
  branchSection.add(rngModeSelect);
  controls.push({ control: rngModeSelect, update: () => rngModeSelect.setValue(tree.options.rngMode) });

  // Stage F: seal the open tube ends (dead/snapped branches, exposed root
  // tips, user-placed branches) so they never show a hole.
  const capEndsToggle = createToggle('枝端封口', tree.options.branch.capEnds !== false, (val) => {
    tree.options.branch.capEnds = val;
    onChange();
  });
  branchSection.add(capEndsToggle);
  controls.push({ control: capEndsToggle, update: () => capEndsToggle.setValue(tree.options.branch.capEnds !== false) });

  // Angle subsection
  const angleSubsection = createSubSection('角度');
  for (let i = 1; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.angle[i], 0, 180, 1, (val) => {
      tree.options.branch.angle[i] = val;
      onChange();
    });
    angleSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.angle[i]) });
  }
  branchSection.add(angleSubsection);

  // Children subsection
  const childrenSubsection = createSubSection('子枝数');
  const childrenRanges = [[0, 100], [1, 25], [2, 20]];
  childrenRanges.forEach(([level, max]) => {
    const slider = createSlider(`层级 ${level}`, tree.options.branch.children[level], 0, max, 1, (val) => {
      tree.options.branch.children[level] = val;
      onChange();
    });
    childrenSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.children[level]) });
  });
  branchSection.add(childrenSubsection);

  // Gnarliness subsection
  const gnarlinessSubsection = createSubSection('蜿蜒度');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.gnarliness[i], -1, 1, 0.01, (val) => {
      tree.options.branch.gnarliness[i] = val;
      onChange();
    });
    gnarlinessSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.gnarliness[i]) });
  }
  branchSection.add(gnarlinessSubsection);

  // Growth Direction subsection
  const forceSubsection = createSubSection('生长方向');
  ['x', 'y', 'z'].forEach(axis => {
    const slider = createSlider(`方向 ${axis.toUpperCase()}`, tree.options.branch.force.direction[axis], -1, 1, 0.01, (val) => {
      tree.options.branch.force.direction[axis] = val;
      onChange();
    });
    forceSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.force.direction[axis]) });
  });
  const strengthSlider = createSlider('强度', tree.options.branch.force.strength, -0.1, 0.1, 0.001, (val) => {
    tree.options.branch.force.strength = val;
    onChange();
  });
  forceSubsection.add(strengthSlider);
  controls.push({ control: strengthSlider, update: () => strengthSlider.setValue(tree.options.branch.force.strength) });
  branchSection.add(forceSubsection);

  // Length subsection
  const lengthSubsection = createSubSection('长度');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.length[i], 0.1, 500, 0.1, (val) => {
      tree.options.branch.length[i] = val;
      onChange();
    });
    lengthSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.length[i]) });
  }
  branchSection.add(lengthSubsection);

  // Radius subsection
  const radiusSubsection = createSubSection('半径');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.radius[i], 0.1, 50, 0.01, (val) => {
      tree.options.branch.radius[i] = val;
      onChange();
    });
    radiusSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.radius[i]) });
  }
  branchSection.add(radiusSubsection);

  // Sections subsection
  const sectionsSubsection = createSubSection('分段数');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.sections[i], 1, 40, 1, (val) => {
      tree.options.branch.sections[i] = val;
      onChange();
    });
    sectionsSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.sections[i]) });
  }
  branchSection.add(sectionsSubsection);

  // Segments subsection
  const segmentsSubsection = createSubSection('径向段数');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.segments[i], 3, 16, 1, (val) => {
      tree.options.branch.segments[i] = val;
      onChange();
    });
    segmentsSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.segments[i]) });
  }
  branchSection.add(segmentsSubsection);

  // Start subsection
  const startSubsection = createSubSection('起始位置');
  for (let i = 1; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.start[i], 0, 1, 0.01, (val) => {
      tree.options.branch.start[i] = val;
      onChange();
    });
    startSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.start[i]) });
  }
  branchSection.add(startSubsection);

  // Taper subsection
  const taperSubsection = createSubSection('锥度');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.taper[i], 0, 1, 0.01, (val) => {
      tree.options.branch.taper[i] = val;
      onChange();
    });
    taperSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.taper[i]) });
  }
  branchSection.add(taperSubsection);

  // Twist subsection
  const twistSubsection = createSubSection('扭转');
  for (let i = 0; i <= 3; i++) {
    const slider = createSlider(`层级 ${i}`, tree.options.branch.twist[i], -0.5, 0.5, 0.01, (val) => {
      tree.options.branch.twist[i] = val;
      onChange();
    });
    twistSubsection.add(slider);
    controls.push({ control: slider, update: () => slider.setValue(tree.options.branch.twist[i]) });
  }
  branchSection.add(twistSubsection);

  parametersTab.appendChild(branchSection.element);

  // ----- Trunk Sculpt Section (stage A) -----
  const trunkSection = createSection('树干塑形 (Trunk Sculpt)', 'share', false);
  const trunkOpt = tree.options.trunk;

  const bottomSwellSlider = createSlider('基部膨大', trunkOpt.bottomSwell, 1, 3, 0.01, (val) => {
    trunkOpt.bottomSwell = val; onChange();
  });
  trunkSection.add(bottomSwellSlider);
  controls.push({ control: bottomSwellSlider, update: () => bottomSwellSlider.setValue(trunkOpt.bottomSwell) });

  const swellHeightSlider = createSlider('膨大高度', trunkOpt.swellHeight, 0.05, 1, 0.01, (val) => {
    trunkOpt.swellHeight = val; onChange();
  });
  trunkSection.add(swellHeightSlider);
  controls.push({ control: swellHeightSlider, update: () => swellHeightSlider.setValue(trunkOpt.swellHeight) });

  const bowSlider = createSlider('弓弯', trunkOpt.bow, 0, 20, 0.1, (val) => {
    trunkOpt.bow = val; onChange();
  });
  trunkSection.add(bowSlider);
  controls.push({ control: bowSlider, update: () => bowSlider.setValue(trunkOpt.bow) });

  const bowHeightSlider = createSlider('弓弯高度', trunkOpt.bowHeight, 0.1, 0.9, 0.01, (val) => {
    trunkOpt.bowHeight = val; onChange();
  });
  trunkSection.add(bowHeightSlider);
  controls.push({ control: bowHeightSlider, update: () => bowHeightSlider.setValue(trunkOpt.bowHeight) });

  const bowDirSlider = createSlider('弓弯方向', trunkOpt.bowDirection, 0, Math.PI * 2, 0.01, (val) => {
    trunkOpt.bowDirection = val; onChange();
  });
  trunkSection.add(bowDirSlider);
  controls.push({ control: bowDirSlider, update: () => bowDirSlider.setValue(trunkOpt.bowDirection) });

  const trunkTwistSlider = createSlider('扭转', trunkOpt.twist, -2, 2, 0.01, (val) => {
    trunkOpt.twist = val; onChange();
  });
  trunkSection.add(trunkTwistSlider);
  controls.push({ control: trunkTwistSlider, update: () => trunkTwistSlider.setValue(trunkOpt.twist) });

  const trunkNoiseSlider = createSlider('表面噪声', trunkOpt.noise, 0, 2, 0.01, (val) => {
    trunkOpt.noise = val; onChange();
  });
  trunkSection.add(trunkNoiseSlider);
  controls.push({ control: trunkNoiseSlider, update: () => trunkNoiseSlider.setValue(trunkOpt.noise) });

  const trunkEnabledToggle = createToggle('启用', trunkOpt.enabled, (val) => {
    trunkOpt.enabled = val; onChange();
  });
  trunkSection.add(trunkEnabledToggle);
  controls.push({ control: trunkEnabledToggle, update: () => trunkEnabledToggle.setValue(trunkOpt.enabled) });

  // ----- Buttress / Roots (板根) subsection (stage B) -----
  const buttSubsection = createSubSection('板根 (Buttress / Roots)');
  const buttOpt = trunkOpt.buttress;

  const buttEnabledToggle = createToggle('启用', buttOpt.enabled, (val) => {
    buttOpt.enabled = val; onChange();
  });
  buttSubsection.add(buttEnabledToggle);
  controls.push({ control: buttEnabledToggle, update: () => buttEnabledToggle.setValue(buttOpt.enabled) });

  const buttFlutesSlider = createSlider('棱纹数', buttOpt.flutes, 0, 12, 1, (val) => {
    buttOpt.flutes = val; onChange();
  });
  buttSubsection.add(buttFlutesSlider);
  controls.push({ control: buttFlutesSlider, update: () => buttFlutesSlider.setValue(buttOpt.flutes) });

  const buttStrengthSlider = createSlider('棱纹强度', buttOpt.strength, 0, 1, 0.01, (val) => {
    buttOpt.strength = val; onChange();
  });
  buttSubsection.add(buttStrengthSlider);
  controls.push({ control: buttStrengthSlider, update: () => buttStrengthSlider.setValue(buttOpt.strength) });

  const buttHeightSlider = createSlider('棱纹高度', buttOpt.height, 0.05, 1, 0.01, (val) => {
    buttOpt.height = val; onChange();
  });
  buttSubsection.add(buttHeightSlider);
  controls.push({ control: buttHeightSlider, update: () => buttHeightSlider.setValue(buttOpt.height) });

  const buttPhaseSlider = createSlider('棱纹相位', buttOpt.phase, 0, Math.PI * 2, 0.01, (val) => {
    buttOpt.phase = val; onChange();
  });
  buttSubsection.add(buttPhaseSlider);
  controls.push({ control: buttPhaseSlider, update: () => buttPhaseSlider.setValue(buttOpt.phase) });

  const buttRootsSlider = createSlider('外露根数', buttOpt.roots, 0, 16, 1, (val) => {
    buttOpt.roots = val; onChange();
  });
  buttSubsection.add(buttRootsSlider);
  controls.push({ control: buttRootsSlider, update: () => buttRootsSlider.setValue(buttOpt.roots) });

  const buttRootLenSlider = createSlider('根长度', buttOpt.rootLength, 1, 20, 0.5, (val) => {
    buttOpt.rootLength = val; onChange();
  });
  buttSubsection.add(buttRootLenSlider);
  controls.push({ control: buttRootLenSlider, update: () => buttRootLenSlider.setValue(buttOpt.rootLength) });

  const buttRootDepthSlider = createSlider('根深度', buttOpt.rootDepth, 0, 8, 0.1, (val) => {
    buttOpt.rootDepth = val; onChange();
  });
  buttSubsection.add(buttRootDepthSlider);
  controls.push({ control: buttRootDepthSlider, update: () => buttRootDepthSlider.setValue(buttOpt.rootDepth) });

  const buttRootWidthSlider = createSlider('根宽度', buttOpt.rootWidth, 0.1, 1, 0.01, (val) => {
    buttOpt.rootWidth = val; onChange();
  });
  buttSubsection.add(buttRootWidthSlider);
  controls.push({ control: buttRootWidthSlider, update: () => buttRootWidthSlider.setValue(buttOpt.rootWidth) });

  trunkSection.add(buttSubsection);

  // ----- Deadwood (枯枝/空洞) subsection (stage D) -----
  const dwSubsection = createSubSection('枯木/空洞 (Deadwood)');
  const dwOpt = trunkOpt.deadwood;

  const dwEnabledToggle = createToggle('启用', dwOpt.enabled, (val) => {
    dwOpt.enabled = val; onChange();
  });
  dwSubsection.add(dwEnabledToggle);
  controls.push({ control: dwEnabledToggle, update: () => dwEnabledToggle.setValue(dwOpt.enabled) });

  const dwHollowStrengthSlider = createSlider('空洞强度', dwOpt.hollowStrength, 0, 1, 0.01, (val) => {
    dwOpt.hollowStrength = val; onChange();
  });
  dwSubsection.add(dwHollowStrengthSlider);
  controls.push({ control: dwHollowStrengthSlider, update: () => dwHollowStrengthSlider.setValue(dwOpt.hollowStrength) });

  const dwHollowHeightSlider = createSlider('空洞高度', dwOpt.hollowHeight, 0.05, 0.9, 0.01, (val) => {
    dwOpt.hollowHeight = val; onChange();
  });
  dwSubsection.add(dwHollowHeightSlider);
  controls.push({ control: dwHollowHeightSlider, update: () => dwHollowHeightSlider.setValue(dwOpt.hollowHeight) });

  const dwHollowWidthSlider = createSlider('空洞宽度', dwOpt.hollowWidth, 0.05, 1, 0.01, (val) => {
    dwOpt.hollowWidth = val; onChange();
  });
  dwSubsection.add(dwHollowWidthSlider);
  controls.push({ control: dwHollowWidthSlider, update: () => dwHollowWidthSlider.setValue(dwOpt.hollowWidth) });

  const dwHollowPhaseSlider = createSlider('空洞相位', dwOpt.hollowPhase, 0, Math.PI * 2, 0.01, (val) => {
    dwOpt.hollowPhase = val; onChange();
  });
  dwSubsection.add(dwHollowPhaseSlider);
  controls.push({ control: dwHollowPhaseSlider, update: () => dwHollowPhaseSlider.setValue(dwOpt.hollowPhase) });

  const dwCrackCountSlider = createSlider('裂纹数量', dwOpt.crackCount, 0, 12, 1, (val) => {
    dwOpt.crackCount = val; onChange();
  });
  dwSubsection.add(dwCrackCountSlider);
  controls.push({ control: dwCrackCountSlider, update: () => dwCrackCountSlider.setValue(dwOpt.crackCount) });

  const dwCrackDepthSlider = createSlider('裂纹深度', dwOpt.crackDepth, 0, 0.5, 0.01, (val) => {
    dwOpt.crackDepth = val; onChange();
  });
  dwSubsection.add(dwCrackDepthSlider);
  controls.push({ control: dwCrackDepthSlider, update: () => dwCrackDepthSlider.setValue(dwOpt.crackDepth) });

  const dwCrackWidthSlider = createSlider('裂纹宽度', dwOpt.crackWidth, 0.01, 0.3, 0.01, (val) => {
    dwOpt.crackWidth = val; onChange();
  });
  dwSubsection.add(dwCrackWidthSlider);
  controls.push({ control: dwCrackWidthSlider, update: () => dwCrackWidthSlider.setValue(dwOpt.crackWidth) });

  const dwCrackPhaseSlider = createSlider('裂纹相位', dwOpt.crackPhase, 0, Math.PI * 2, 0.01, (val) => {
    dwOpt.crackPhase = val; onChange();
  });
  dwSubsection.add(dwCrackPhaseSlider);
  controls.push({ control: dwCrackPhaseSlider, update: () => dwCrackPhaseSlider.setValue(dwOpt.crackPhase) });

  const dwDeadChanceSlider = createSlider('枯枝概率', dwOpt.deadBranchChance, 0, 1, 0.01, (val) => {
    dwOpt.deadBranchChance = val; onChange();
  });
  dwSubsection.add(dwDeadChanceSlider);
  controls.push({ control: dwDeadChanceSlider, update: () => dwDeadChanceSlider.setValue(dwOpt.deadBranchChance) });

  const dwDeadLenSlider = createSlider('枯枝长度', dwOpt.deadBranchLength, 0.2, 1, 0.01, (val) => {
    dwOpt.deadBranchLength = val; onChange();
  });
  dwSubsection.add(dwDeadLenSlider);
  controls.push({ control: dwDeadLenSlider, update: () => dwDeadLenSlider.setValue(dwOpt.deadBranchLength) });

  trunkSection.add(dwSubsection);

  parametersTab.appendChild(trunkSection.element);

  // ----- Global Pose Section (stage E) -----
  const globalSection = createSection('整体姿态 (Global Pose)', 'share', false);
  const gOpt = tree.options.global;

  const leanXSlider = createSlider('倾斜 X', gOpt.lean.x, -0.05, 0.05, 0.001, (val) => {
    gOpt.lean.x = val; onChange();
  });
  globalSection.add(leanXSlider);
  controls.push({ control: leanXSlider, update: () => leanXSlider.setValue(gOpt.lean.x) });

  const leanZSlider = createSlider('倾斜 Z', gOpt.lean.z, -0.05, 0.05, 0.001, (val) => {
    gOpt.lean.z = val; onChange();
  });
  globalSection.add(leanZSlider);
  controls.push({ control: leanZSlider, update: () => leanZSlider.setValue(gOpt.lean.z) });

  const globalTwistSlider = createSlider('扭转', gOpt.twist, -0.05, 0.05, 0.001, (val) => {
    gOpt.twist = val; onChange();
  });
  globalSection.add(globalTwistSlider);
  controls.push({ control: globalTwistSlider, update: () => globalTwistSlider.setValue(gOpt.twist) });

  const asymXSlider = createSlider('不对称 X', gOpt.asymmetry.x, -0.05, 0.05, 0.001, (val) => {
    gOpt.asymmetry.x = val; onChange();
  });
  globalSection.add(asymXSlider);
  controls.push({ control: asymXSlider, update: () => asymXSlider.setValue(gOpt.asymmetry.x) });

  const asymZSlider = createSlider('不对称 Z', gOpt.asymmetry.z, -0.05, 0.05, 0.001, (val) => {
    gOpt.asymmetry.z = val; onChange();
  });
  globalSection.add(asymZSlider);
  controls.push({ control: asymZSlider, update: () => asymZSlider.setValue(gOpt.asymmetry.z) });

  const globalEnabledToggle = createToggle('启用', gOpt.enabled, (val) => {
    gOpt.enabled = val; onChange();
  });
  globalSection.add(globalEnabledToggle);
  controls.push({ control: globalEnabledToggle, update: () => globalEnabledToggle.setValue(gOpt.enabled) });

  // One-click "ancient cypress" (Zhang-Fei-bai) pose: bulged base, slight
  // bow + twist, gentle overall lean/spiral and denser, thicker trunk.
  const guobaiBtn = createButton('古柏预设 (Ancient Cypress)', 'sparkles', () => {
    trunkOpt.bottomSwell = 1.8;
    trunkOpt.swellHeight = 0.3;
    trunkOpt.bow = 6;
    trunkOpt.bowHeight = 0.55;
    trunkOpt.bowDirection = 0.4;
    trunkOpt.twist = 0.25;
    trunkOpt.noise = 0.8;
    trunkOpt.enabled = true;
    // Stage B: buttress roots — fluted base + a few exposed root fingers.
    trunkOpt.buttress.enabled = true;
    trunkOpt.buttress.flutes = 6;
    trunkOpt.buttress.strength = 0.4;
    trunkOpt.buttress.height = 0.28;
    trunkOpt.buttress.phase = 0.3;
    trunkOpt.buttress.roots = 7;
    trunkOpt.buttress.rootLength = 7;
    trunkOpt.buttress.rootDepth = 2.2;
    trunkOpt.buttress.rootWidth = 0.7;
    // More radial segments so the flutes read as smooth ridges, not facets.
    tree.options.branch.segments[0] = 12;
    // Stage D: deadwood — a hollow + vertical cracks + some dead branches
    // for the weathered, ancient look.
    trunkOpt.deadwood.enabled = true;
    trunkOpt.deadwood.hollowStrength = 0.35;
    trunkOpt.deadwood.hollowHeight = 0.25;
    trunkOpt.deadwood.hollowWidth = 0.3;
    trunkOpt.deadwood.hollowPhase = 2.1;
    trunkOpt.deadwood.crackCount = 4;
    trunkOpt.deadwood.crackDepth = 0.12;
    trunkOpt.deadwood.crackWidth = 0.05;
    trunkOpt.deadwood.crackPhase = 0.5;
    trunkOpt.deadwood.deadBranchChance = 0.15;
    trunkOpt.deadwood.deadBranchLength = 0.55;
    gOpt.lean.x = 0.008;
    gOpt.lean.z = 0.005;
    gOpt.twist = 0.008;
    gOpt.asymmetry.x = 0.004;
    gOpt.asymmetry.z = 0.0;
    gOpt.enabled = true;
    tree.options.branch.radius[0] = 8;
    tree.options.branch.length[0] = 40;
    // Cloud-slab foliage (云片叶簇): spread flat horizontal puffs across the
    // upper branches so the canopy reads as an ancient cypress rather than a
    // lollipop of billboard leaves.
    slabOpt.enabled = true;
    slabOpt.radius = 6;
    slabOpt.thickness = 1.5;
    slabOpt.layers = 3;
    slabOpt.tilt = 12;
    slabOpt.segments = 12;
    tree.options.leaves.count = 3;
    tree.options.leaves.level = 2;
    onChange();
    refreshAllControls();
  });
  globalSection.add(guobaiBtn);

  parametersTab.appendChild(globalSection.element);

  // ----- Selected Branch Section (per-branch editing) -----
  const selectedSection = createSection('选中枝干 (Selected Branch)', 'share', false);
  const selectedContent = selectedSection.content;

  function clearSelectedControls() {
    selectedContent.innerHTML = '';
  }

  /**
   * (Re)builds the per-branch editor for the given skeleton branch index.
   * null clears the selection.
   */
  function buildSelectedBranchPanel(index) {
    selectedIndex = index;
    clearSelectedControls();
    tree.setSelectedBranch(index);

    if (index == null) {
      const hint = document.createElement('div');
      hint.className = 'control-row';
      hint.style.opacity = '0.7';
      hint.textContent = '点击场景中的枝干，即可单独编辑它。';
      selectedContent.appendChild(hint);
      return;
    }

    const info = tree.getBranchInfo(index);
    if (!info) {
      const hint = document.createElement('div');
      hint.className = 'control-row';
      hint.textContent = '未找到该枝干。';
      selectedContent.appendChild(hint);
      return;
    }

    const pathDisplay = createDisplay('路径', info.path);
    selectedContent.appendChild(pathDisplay.element);

    // ----- User-placed branch (right-click → add) -----
    // Offers sliding along / rotating around the parent, plus removal.
    // Procedural branches skip this block entirely.
    if (info.user) {
      const userHeader = document.createElement('div');
      userHeader.className = 'control-row';
      userHeader.style.fontWeight = '600';
      userHeader.textContent = '自定义枝干';
      selectedContent.appendChild(userHeader);

      const parentDisplay = createDisplay('父枝', info.user.parentPath);
      selectedContent.appendChild(parentDisplay.element);

      const tSlider = createSlider(
        '父级位置', info.user.t ?? 0.5, 0.02, 0.98, 0.01,
        (val) => { tree.moveUserBranch(info.path, { t: val }); onChange(); },
      );
      selectedContent.appendChild(tSlider.element);

      const radialDeg = ((info.user.radialAngle ?? 0) * 180 / Math.PI + 360) % 360;
      const radialSlider = createSlider(
        '径向角度', radialDeg, 0, 360, 1,
        (val) => {
          tree.moveUserBranch(info.path, { radialAngle: val * Math.PI / 180 });
          onChange();
        },
      );
      selectedContent.appendChild(radialSlider.element);

      const dragHint = document.createElement('div');
      dragHint.className = 'control-row';
      dragHint.style.opacity = '0.7';
      dragHint.textContent = '提示：在场景中按住该枝干拖动，可让它沿父枝滑动。';
      selectedContent.appendChild(dragHint);

      const delBtn = createButton('删除此枝干', 'folderOpen', () => {
        tree.removeUserBranch(info.path);
        onChange();
        buildSelectedBranchPanel(null);
      });
      selectedContent.appendChild(delBtn.element);
    }

    const makeOverrideSlider = (label, key, value, min, max, step) => {
      const slider = createSlider(label, value, min, max, step, (val) => {
        tree.setBranchOverride(info.path, key, val);
        onChange();
      });
      selectedContent.appendChild(slider.element);
      return slider;
    };

    makeOverrideSlider('长度', 'length', info.length, 0.1, 500, 0.1);
    makeOverrideSlider('半径', 'radius', info.radius, 0.05, 50, 0.05);
    makeOverrideSlider('角度', 'angle', info.angle, 0, 180, 1);
    makeOverrideSlider('子枝数', 'children', info.children, 0, 50, 1);
    makeOverrideSlider('蜿蜒度', 'gnarliness', info.gnarliness, -1, 1, 0.01);
    makeOverrideSlider('锥度', 'taper', info.taper, 0, 1, 0.01);
    makeOverrideSlider('扭转', 'twist', info.twist, -1, 1, 0.01);
    makeOverrideSlider('分段数', 'sections', info.sections, 1, 40, 1);
    makeOverrideSlider('起始', 'start', info.start, 0, 1, 0.01);

    // ----- Curve (bend) control points -----
    const curveHeader = document.createElement('div');
    curveHeader.className = 'control-row';
    curveHeader.style.fontWeight = '600';
    curveHeader.textContent = '弯曲控制点';
    selectedContent.appendChild(curveHeader);

    const curvePoints = (tree.options.branch.overrides[info.path]?.curve) || [];
    const rebuildCurve = () => buildSelectedBranchPanel(selectedIndex);

    curvePoints.forEach((cp, ci) => {
      const tSlider = createSlider(
        `#${ci} 位置`,
        cp.t ?? 0.5, 0, 1, 0.01,
        (val) => { cp.t = val; tree.setBranchOverride(info.path, 'curve', curvePoints); onChange(); },
      );
      selectedContent.appendChild(tSlider.element);

      ['x', 'y', 'z'].forEach((axis) => {
        const dSlider = createSlider(
          `#${ci} 方向 ${axis.toUpperCase()}`,
          cp.dir?.[axis] ?? 0, -1, 1, 0.01,
          (val) => {
            if (!cp.dir) cp.dir = { x: 0, y: 0, z: 0 };
            cp.dir[axis] = val;
            tree.setBranchOverride(info.path, 'curve', curvePoints);
            onChange();
          },
        );
        selectedContent.appendChild(dSlider.element);
      });

      const sSlider = createSlider(
        `#${ci} 强度`,
        cp.strength ?? 0.5, 0, 2, 0.01,
        (val) => { cp.strength = val; tree.setBranchOverride(info.path, 'curve', curvePoints); onChange(); },
      );
      selectedContent.appendChild(sSlider.element);

      const rmBtn = createButton('移除控制点', 'folderOpen', () => {
        curvePoints.splice(ci, 1);
        tree.setBranchOverride(info.path, 'curve', curvePoints);
        onChange();
        rebuildCurve();
      });
      selectedContent.appendChild(rmBtn.element);
    });

    const addBtn = createButton('添加弯曲控制点', 'share', () => {
      curvePoints.push({ t: 0.5, dir: { x: 0, y: 0, z: 1 }, strength: 0.5 });
      tree.setBranchOverride(info.path, 'curve', curvePoints);
      onChange();
      rebuildCurve();
    });
    selectedContent.appendChild(addBtn.element);

    const clearBtn = createButton('清除覆盖', 'folderOpen', () => {
      if (tree.options.branch.overrides[info.path]) {
        delete tree.options.branch.overrides[info.path];
      }
      onChange();
      rebuildCurve();
    });
    selectedContent.appendChild(clearBtn.element);

    selectedSection.setExpanded(true);
  }

  // Real implementation used by the scene raycaster (via the returned API)
  // and the preset/load handlers below.
  selectBranch = (index) => {
    buildSelectedBranchPanel(index);
    selectedSection.setExpanded(true);
  };

  parametersTab.appendChild(selectedSection.element);
  buildSelectedBranchPanel(null);

  // ----- Leaves Section -----
  const leavesSection = createSection('树叶 (Leaves)', 'sparkles', false);

  const leafTypeSelect = createSelect('类型',
    { '白蜡 (Ash)': 'ash', '白杨 (Aspen)': 'aspen', '橡树 (Oak)': 'oak', '松树 (Pine)': 'pine' },
    tree.options.leaves.type, (val) => {
    tree.options.leaves.type = val;
    onChange();
  });
  leavesSection.add(leafTypeSelect);
  controls.push({ control: leafTypeSelect, update: () => leafTypeSelect.setValue(tree.options.leaves.type) });

  const leafTintPicker = createColorPicker('色调', tree.options.leaves.tint, (val) => {
    tree.options.leaves.tint = val;
    onChange();
  });
  leavesSection.add(leafTintPicker);
  controls.push({ control: leafTintPicker, update: () => leafTintPicker.setValue(tree.options.leaves.tint) });

  const billboardSelect = createSelect('公告板',
    { '单片 (Single)': 'single', '双片 (Double)': 'double' },
    tree.options.leaves.billboard, (val) => {
    tree.options.leaves.billboard = val;
    onChange();
  });
  leavesSection.add(billboardSelect);
  controls.push({ control: billboardSelect, update: () => billboardSelect.setValue(tree.options.leaves.billboard) });

  const leafAngleSlider = createSlider('角度', tree.options.leaves.angle, 0, 100, 1, (val) => {
    tree.options.leaves.angle = val;
    onChange();
  });
  leavesSection.add(leafAngleSlider);
  controls.push({ control: leafAngleSlider, update: () => leafAngleSlider.setValue(tree.options.leaves.angle) });

  const leafCountSlider = createSlider('数量', tree.options.leaves.count, 0, 1000, 1, (val) => {
    tree.options.leaves.count = val;
    onChange();
  });
  leavesSection.add(leafCountSlider);
  controls.push({ control: leafCountSlider, update: () => leafCountSlider.setValue(tree.options.leaves.count) });

  // Lowest branch level that sprouts leaves (inclusive). Lowering it makes
  // more branch levels carry leaves, filling the canopy on large trees.
  const leafLevelSlider = createSlider('最小层级', tree.options.leaves.level, 1, 3, 1, (val) => {
    tree.options.leaves.level = val;
    onChange();
  });
  leavesSection.add(leafLevelSlider);
  controls.push({ control: leafLevelSlider, update: () => leafLevelSlider.setValue(tree.options.leaves.level) });

  // Density scaling: longer branches get proportionally more leaves.
  const leafDensitySlider = createSlider('密度', tree.options.leaves.density, 0, 2, 0.05, (val) => {
    tree.options.leaves.density = val;
    onChange();
  });
  leavesSection.add(leafDensitySlider);
  controls.push({ control: leafDensitySlider, update: () => leafDensitySlider.setValue(tree.options.leaves.density) });

  const leafStartSlider = createSlider('起始', tree.options.leaves.start, 0, 1, 0.01, (val) => {
    tree.options.leaves.start = val;
    onChange();
  });
  leavesSection.add(leafStartSlider);
  controls.push({ control: leafStartSlider, update: () => leafStartSlider.setValue(tree.options.leaves.start) });

  const leafSizeSlider = createSlider('大小', tree.options.leaves.size, 0, 30, 0.1, (val) => {
    tree.options.leaves.size = val;
    onChange();
  });
  leavesSection.add(leafSizeSlider);
  controls.push({ control: leafSizeSlider, update: () => leafSizeSlider.setValue(tree.options.leaves.size) });

  const leafVarianceSlider = createSlider('大小变化', tree.options.leaves.sizeVariance, 0, 1, 0.01, (val) => {
    tree.options.leaves.sizeVariance = val;
    onChange();
  });
  leavesSection.add(leafVarianceSlider);
  controls.push({ control: leafVarianceSlider, update: () => leafVarianceSlider.setValue(tree.options.leaves.sizeVariance) });

  const alphaTestSlider = createSlider('Alpha 测试', tree.options.leaves.alphaTest, 0, 1, 0.01, (val) => {
    tree.options.leaves.alphaTest = val;
    onChange();
  });
  leavesSection.add(alphaTestSlider);
  controls.push({ control: alphaTestSlider, update: () => alphaTestSlider.setValue(tree.options.leaves.alphaTest) });

  const roundedNormalsToggle = createToggle('圆滑法线', tree.options.leaves.roundedNormals, (val) => {
    tree.options.leaves.roundedNormals = val;
    onChange();
  });
  leavesSection.add(roundedNormalsToggle);
  controls.push({ control: roundedNormalsToggle, update: () => roundedNormalsToggle.setValue(tree.options.leaves.roundedNormals) });

  // ----- Cloud Slab (云片) subsection (stage C) -----
  const slabSubsection = createSubSection('云片叶簇 (Cloud Slab)');
  const slabOpt = tree.options.leaves.slab;

  const slabEnabledToggle = createToggle('启用', slabOpt.enabled, (val) => {
    slabOpt.enabled = val; onChange();
  });
  slabSubsection.add(slabEnabledToggle);
  controls.push({ control: slabEnabledToggle, update: () => slabEnabledToggle.setValue(slabOpt.enabled) });

  const slabRadiusSlider = createSlider('半径', slabOpt.radius, 1, 20, 0.5, (val) => {
    slabOpt.radius = val; onChange();
  });
  slabSubsection.add(slabRadiusSlider);
  controls.push({ control: slabRadiusSlider, update: () => slabRadiusSlider.setValue(slabOpt.radius) });

  const slabThicknessSlider = createSlider('厚度', slabOpt.thickness, 0.2, 5, 0.1, (val) => {
    slabOpt.thickness = val; onChange();
  });
  slabSubsection.add(slabThicknessSlider);
  controls.push({ control: slabThicknessSlider, update: () => slabThicknessSlider.setValue(slabOpt.thickness) });

  const slabLayersSlider = createSlider('层数', slabOpt.layers, 1, 5, 1, (val) => {
    slabOpt.layers = val; onChange();
  });
  slabSubsection.add(slabLayersSlider);
  controls.push({ control: slabLayersSlider, update: () => slabLayersSlider.setValue(slabOpt.layers) });

  const slabTiltSlider = createSlider('倾斜角 (°)', slabOpt.tilt, 0, 40, 1, (val) => {
    slabOpt.tilt = val; onChange();
  });
  slabSubsection.add(slabTiltSlider);
  controls.push({ control: slabTiltSlider, update: () => slabTiltSlider.setValue(slabOpt.tilt) });

  const slabSegmentsSlider = createSlider('径向段数', slabOpt.segments, 6, 20, 1, (val) => {
    slabOpt.segments = val; onChange();
  });
  slabSubsection.add(slabSegmentsSlider);
  controls.push({ control: slabSegmentsSlider, update: () => slabSegmentsSlider.setValue(slabOpt.segments) });

  leavesSection.add(slabSubsection);

  parametersTab.appendChild(leavesSection.element);

  // ----- Trellis Section -----
  const trellisSection = createSection('藤架 (Trellis)', 'share', false);

  const trellisEnabledToggle = createToggle('启用', tree.options.trellis.enabled, (val) => {
    tree.options.trellis.enabled = val;
    onChange();
  });
  trellisSection.add(trellisEnabledToggle);
  controls.push({ control: trellisEnabledToggle, update: () => trellisEnabledToggle.setValue(tree.options.trellis.enabled) });

  const trellisVisibleToggle = createToggle('可见', tree.options.trellis.visible, (val) => {
    tree.options.trellis.visible = val;
    onChange();
  });
  trellisSection.add(trellisVisibleToggle);
  controls.push({ control: trellisVisibleToggle, update: () => trellisVisibleToggle.setValue(tree.options.trellis.visible) });

  // Position subsection
  const trellisPositionSubsection = createSubSection('位置');
  const trellisPosXSlider = createSlider('X', tree.options.trellis.position.x, -20, 20, 0.1, (val) => {
    tree.options.trellis.position.x = val;
    onChange();
  });
  trellisPositionSubsection.add(trellisPosXSlider);
  controls.push({ control: trellisPosXSlider, update: () => trellisPosXSlider.setValue(tree.options.trellis.position.x) });

  const trellisPosYSlider = createSlider('Y', tree.options.trellis.position.y, -10, 10, 0.1, (val) => {
    tree.options.trellis.position.y = val;
    onChange();
  });
  trellisPositionSubsection.add(trellisPosYSlider);
  controls.push({ control: trellisPosYSlider, update: () => trellisPosYSlider.setValue(tree.options.trellis.position.y) });

  const trellisPosZSlider = createSlider('Z', tree.options.trellis.position.z, -20, 20, 0.1, (val) => {
    tree.options.trellis.position.z = val;
    onChange();
  });
  trellisPositionSubsection.add(trellisPosZSlider);
  controls.push({ control: trellisPosZSlider, update: () => trellisPosZSlider.setValue(tree.options.trellis.position.z) });
  trellisSection.add(trellisPositionSubsection);

  // Dimensions subsection
  const trellisDimensionsSubsection = createSubSection('尺寸');
  const trellisWidthSlider = createSlider('宽度', tree.options.trellis.width, 1, 50, 0.5, (val) => {
    tree.options.trellis.width = val;
    onChange();
  });
  trellisDimensionsSubsection.add(trellisWidthSlider);
  controls.push({ control: trellisWidthSlider, update: () => trellisWidthSlider.setValue(tree.options.trellis.width) });

  const trellisHeightSlider = createSlider('高度', tree.options.trellis.height, 1, 50, 0.5, (val) => {
    tree.options.trellis.height = val;
    onChange();
  });
  trellisDimensionsSubsection.add(trellisHeightSlider);
  controls.push({ control: trellisHeightSlider, update: () => trellisHeightSlider.setValue(tree.options.trellis.height) });

  const trellisSpacingSlider = createSlider('间距', tree.options.trellis.spacing, 0.5, 10, 0.1, (val) => {
    tree.options.trellis.spacing = val;
    onChange();
  });
  trellisDimensionsSubsection.add(trellisSpacingSlider);
  controls.push({ control: trellisSpacingSlider, update: () => trellisSpacingSlider.setValue(tree.options.trellis.spacing) });
  trellisSection.add(trellisDimensionsSubsection);

  // Force subsection
  const trellisForceSubsection = createSubSection('作用力');
  const trellisStrengthSlider = createSlider('强度', tree.options.trellis.force.strength, 0, 0.2, 0.001, (val) => {
    tree.options.trellis.force.strength = val;
    onChange();
  });
  trellisForceSubsection.add(trellisStrengthSlider);
  controls.push({ control: trellisStrengthSlider, update: () => trellisStrengthSlider.setValue(tree.options.trellis.force.strength) });

  const trellisMaxDistSlider = createSlider('最大距离', tree.options.trellis.force.maxDistance, 0.5, 20, 0.1, (val) => {
    tree.options.trellis.force.maxDistance = val;
    onChange();
  });
  trellisForceSubsection.add(trellisMaxDistSlider);
  controls.push({ control: trellisMaxDistSlider, update: () => trellisMaxDistSlider.setValue(tree.options.trellis.force.maxDistance) });

  const trellisFalloffSlider = createSlider('衰减', tree.options.trellis.force.falloff, 0.1, 3, 0.1, (val) => {
    tree.options.trellis.force.falloff = val;
    onChange();
  });
  trellisForceSubsection.add(trellisFalloffSlider);
  controls.push({ control: trellisFalloffSlider, update: () => trellisFalloffSlider.setValue(tree.options.trellis.force.falloff) });
  trellisSection.add(trellisForceSubsection);

  // Appearance subsection
  const trellisAppearanceSubsection = createSubSection('外观');
  const trellisCylinderRadiusSlider = createSlider('圆柱半径', tree.options.trellis.cylinderRadius, 0.01, 0.5, 0.01, (val) => {
    tree.options.trellis.cylinderRadius = val;
    onChange();
  });
  trellisAppearanceSubsection.add(trellisCylinderRadiusSlider);
  controls.push({ control: trellisCylinderRadiusSlider, update: () => trellisCylinderRadiusSlider.setValue(tree.options.trellis.cylinderRadius) });

  const trellisColorPicker = createColorPicker('颜色', tree.options.trellis.color, (val) => {
    tree.options.trellis.color = val;
    onChange();
  });
  trellisAppearanceSubsection.add(trellisColorPicker);
  controls.push({ control: trellisColorPicker, update: () => trellisColorPicker.setValue(tree.options.trellis.color) });
  trellisSection.add(trellisAppearanceSubsection);

  parametersTab.appendChild(trellisSection.element);

  // ----- Camera Section -----
  const cameraSection = createSection('相机 (Camera)', 'videoCamera', false);

  const autoRotateToggle = createToggle('自动旋转', orbitControls.autoRotate, (val) => {
    orbitControls.autoRotate = val;
  });
  cameraSection.add(autoRotateToggle);
  controls.push({ control: autoRotateToggle, update: () => autoRotateToggle.setValue(orbitControls.autoRotate) });

  const rotateSpeedSlider = createSlider('旋转速度', orbitControls.autoRotateSpeed, 0, 2, 0.1, (val) => {
    orbitControls.autoRotateSpeed = val;
  });
  cameraSection.add(rotateSpeedSlider);
  controls.push({ control: rotateSpeedSlider, update: () => rotateSpeedSlider.setValue(orbitControls.autoRotateSpeed) });

  parametersTab.appendChild(cameraSection.element);

  // ----- Environment Section -----
  const environmentSection = createSection('环境 (Environment)', 'sun', false);

  const sunAzimuthSlider = createSlider('太阳角度', environment.skybox.sunAzimuth, 0, 360, 1, (val) => {
    environment.skybox.sunAzimuth = val;
  });
  environmentSection.add(sunAzimuthSlider);
  controls.push({ control: sunAzimuthSlider, update: () => sunAzimuthSlider.setValue(environment.skybox.sunAzimuth) });

  const grassCountSlider = createSlider('草地数量', environment.grass.instanceCount, 0, 25000, 100, (val) => {
    environment.grass.instanceCount = val;
  });
  environmentSection.add(grassCountSlider);
  controls.push({ control: grassCountSlider, update: () => grassCountSlider.setValue(environment.grass.instanceCount) });

  parametersTab.appendChild(environmentSection.element);

  // ----- Info Section -----
  const infoSection = createSection('信息 (Info)', 'info', false);

  const vertexDisplay = createDisplay('顶点数', tree.vertexCount, (v) => Math.round(v).toLocaleString());
  infoSection.add(vertexDisplay);

  const triangleDisplay = createDisplay('三角形数', tree.triangleCount, (v) => Math.round(v).toLocaleString());
  infoSection.add(triangleDisplay);

  const versionDisplay = createDisplay('版本', version);
  infoSection.add(versionDisplay);

  const aboutBtn = createButton('关于', 'info', () => {
    document.getElementById('aboutOverlay').classList.add('active');
  });
  infoSection.add(aboutBtn);

  parametersTab.appendChild(infoSection.element);

  function updateInfoDisplays() {
    const { vertices, triangles } = displayedCounts();
    vertexDisplay.setValue(vertices);
    triangleDisplay.setValue(triangles);
    statsVertices.textContent = Math.round(vertices).toLocaleString();
    statsTriangles.textContent = Math.round(triangles).toLocaleString();
    statsBuildTime.textContent = lastBuildMs == null ? '–' : Math.max(1, Math.round(lastBuildMs)).toString();
    pulseStat(statsTriangles);
    pulseStat(statsVertices);
    pulseStat(statsBuildTime);
  }

  // ============================================================================
  // Export Tab Content
  // ============================================================================

  const exportSection = createSection('保存与加载 (Save & Load)', 'folder', true);

  const savePresetBtn = createButton('保存预设', 'document', () => {
    const link = document.getElementById('downloadLink');
    const json = JSON.stringify(tree.options, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    link.href = URL.createObjectURL(blob);
    link.download = 'tree.json';
    link.click();
  });
  exportSection.add(savePresetBtn);

  const loadPresetBtn = createButton('加载预设', 'folderOpen', () => {
    document.getElementById('fileInput').click();
  });
  exportSection.add(loadPresetBtn);

  exportTab.appendChild(exportSection.element);

  const exportModelsSection = createSection('导出模型 (Export Models)', 'cubeTransparent', true);

  /**
   * GLTFExporter aborts on textures whose image never loaded (e.g. the
   * texture file is missing on disk). Rendering tolerates them, so strip
   * them from the materials for the duration of an export and restore after.
   * @param {THREE.Object3D} root
   * @returns {() => void} restore function
   */
  function stripBrokenTextures(root) {
    const restores = [];
    root.traverse((o) => {
      const materials = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const material of materials) {
        for (const key of ['map', 'aoMap', 'normalMap', 'roughnessMap', 'metalnessMap']) {
          const texture = material[key];
          if (texture?.isTexture && !texture.image) {
            restores.push(() => { material[key] = texture; });
            material[key] = null;
          }
        }
      }
    });
    return () => restores.forEach((restore) => restore());
  }

  const exportGlbBtn = createButton('导出 GLB（完整细节）', 'download', async ({ setStatus }) => {
    setStatus('正在导出 GLB…');
    // Export at full detail regardless of the active LOD preview
    const restoreLevel = previewLevel;
    if (restoreLevel !== 0) {
      setPreviewLevel(0);
    }
    const restoreTextures = stripBrokenTextures(tree);
    try {
      await paint();
      const glb = await new Promise((resolve, reject) =>
        exporter.parse(tree, resolve, reject, { binary: true }),
      );
      const blob = new Blob([glb], { type: 'application/octet-stream' });
      const link = document.getElementById('downloadLink');
      link.href = window.URL.createObjectURL(blob);
      link.download = 'tree.glb';
      link.click();
    } catch (err) {
      console.error(err);
    } finally {
      restoreTextures();
      if (restoreLevel !== 0) {
        setPreviewLevel(restoreLevel);
      }
    }
  });
  exportModelsSection.add(exportGlbBtn);

  const exportLodsBtn = createButton('导出 LOD 包 (ZIP)', 'archive', async ({ setStatus }) => {
    const restoreTextures = stripBrokenTextures(tree);
    try {
      const files = {};
      for (let i = 0; i < Tree.defaultLODLevels.length; i++) {
        setStatus(`正在导出 LOD ${i + 1}/${Tree.defaultLODLevels.length}…`);
        await paint();

        const { detail } = Tree.defaultLODLevels[i];
        const { branches, leaves } = tree.createGeometry(detail ?? {});

        try {
          const branchesMesh = new THREE.Mesh(branches, tree.branchesMesh.material);
          branchesMesh.name = `Branches_LOD${i}`;
          const leavesMesh = new THREE.Mesh(leaves, tree.leavesMesh.material);
          leavesMesh.name = `Leaves_LOD${i}`;
          const group = new THREE.Group();
          group.name = `Tree_LOD${i}`;
          group.add(branchesMesh, leavesMesh);

          const glb = await new Promise((resolve, reject) =>
            exporter.parse(group, resolve, reject, { binary: true }),
          );
          files[`tree_LOD${i}.glb`] = new Uint8Array(glb);
        } finally {
          branches.dispose();
          leaves.dispose();
        }
      }

      setStatus('正在压缩…');
      await paint();

      const blob = new Blob([zipSync(files)], { type: 'application/zip' });
      const link = document.getElementById('downloadLink');
      link.href = URL.createObjectURL(blob);
      link.download = 'tree_lods.zip';
      link.click();
    } catch (err) {
      console.error(err);
    } finally {
      restoreTextures();
    }
  });
  exportModelsSection.add(exportLodsBtn);

  const exportPngBtn = createButton('导出 PNG', 'photo', async ({ setStatus }) => {
    setStatus('正在导出 PNG…');
    await paint();

    renderer.setClearColor(0, 0);
    const fog = scene.fog;
    scene.fog = null;

    scene.traverse((o) => {
      if (o.name === 'Skybox') {
        o.material.side = THREE.FrontSide;
      } else if (o.isMesh) {
        o.visible = false;
      }
    });
    tree.traverse((o) => o.visible = true);

    try {
      renderer.render(scene, camera);

      const link = document.getElementById('downloadLink');
      link.href = renderer.domElement.toDataURL('image/png');
      link.download = 'tree.png';
      link.click();
    } catch (err) {
      console.error(err);
    } finally {
      renderer.setClearColor(0);
      scene.fog = fog;
      scene.traverse((o) => {
        if (o.name === 'Skybox') {
          o.material.side = THREE.BackSide;
        }
        o.visible = true;
      });
    }
  });
  exportModelsSection.add(exportPngBtn);

  exportTab.appendChild(exportModelsSection.element);

  // Panel footer with course link
  const footer = document.createElement('div');
  footer.className = 'panel-footer';
  footer.innerHTML = `
    <p class="panel-footer-heading">喜欢 EZ-Tree？试试我的其他作品</p>
    <a href="https://threejsroadmap.com/assets/threejs-water-pro?utm_source=eztree" target="_blank" class="panel-footer-link">
      🌊 Three.js Water Pro
    </a>
    <a href="https://threejsroadmap.com/assets/threejs-sky-pro?utm_source=eztree" target="_blank" class="panel-footer-link">
      ☁️ Three.js Sky Pro
    </a>
  `;
  panel.appendChild(footer);

  // Add panel to container
  container.appendChild(panel);

  // File input handler
  const fileInput = document.getElementById('fileInput');
  const newFileInput = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(newFileInput, fileInput);

  newFileInput.addEventListener('change', function (event) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          tree.options = JSON.parse(e.target.result);
          tree.options.rngMode = tree.options.rngMode || 'perBranch';
          tree.generate();
          if (previewLevel > 0) {
            applyLODPreview();
          }
          selectBranch(null);
          refreshAllControls();
        } catch (error) {
          console.error('Error parsing JSON:', error);
        }
      };
      reader.onerror = function (e) {
        console.error('Error reading file:', e);
      };
      reader.readAsText(file);
    }
    // Reset file input
    newFileInput.value = '';
  });

  // Refresh all controls to match current tree options
  function refreshAllControls() {
    controls.forEach(({ update }) => update());
    updateInfoDisplays();
  }

  // Initialize the stats overlay with the current tree's counts
  updateInfoDisplays();

  // Mobile expand/collapse functionality
  setupMobileToggle(panel, header);

  // Expose the branch-picking API to the scene/raycaster.
  return { selectBranch, regenerate: onChange };
}

/**
 * Sets up the mobile bottom sheet: the whole header is the tap target,
 * and the panel starts collapsed so the scene stays the hero.
 */
function setupMobileToggle(panel, header) {
  const mobileQuery = window.matchMedia('(max-width: 800px)');

  header.addEventListener('click', () => {
    if (!mobileQuery.matches) return;
    panel.classList.toggle('collapsed');
  });

  if (mobileQuery.matches) {
    panel.classList.add('collapsed');
  }
}
