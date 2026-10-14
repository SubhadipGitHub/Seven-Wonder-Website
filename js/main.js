/**
 * main.js
 * ---------------------------------------------------------------------------
 * Boot sequence, scene, renderer, lighting, environment, camera controls,
 * render loop, resize handling and the model-loading pipeline.
 *
 *   1. detect a quality tier (particle count, DPR cap, shadows)
 *   2. load data/wonders.json and build the UI (plus tour + ambience)
 *   3. build the procedural stand-ins → dissolve-patch → sample clouds
 *   4. render live thumbnails of each model for the rail
 *   5. intro: dust condenses into the first wonder; sky and light follow
 *      the real sun at that wonder (sky.js), refreshed every minute
 *   6. in the background, swap in any Draco .glb models listed in the JSON
 *
 * Scene graph:
 *   scene
 *    ├─ lights, ground (shadow catcher), survey ring, dust
 *    └─ pivot   (mouse parallax tilt)
 *        └─ stage (slow auto-rotation + float)
 *            ├─ wonder roots ×8 (only the current one visible at rest)
 *            └─ morph particles
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import gsap from 'gsap';

import { createParticleMaterial, createParticleGeometry, applyDissolve, createDust } from './morphShader.js';
import { buildProceduralWonder, normalizeModel } from './proceduralWonders.js';
import { samplePointCloud, fitCount, scatterCloud, mulberry32, seedFrom } from './pointCloud.js';
import { MorphController } from './MorphController.js';
import { createUI } from './ui.js';
import { createTour } from './tour.js';
import { createAmbience } from './audio.js';
import { sunAt, skyState, phaseOf, localTime, PREVIEWS, PREVIEW_ORDER } from './sky.js';

const CONFIG = {
  dataUrl: './data/wonders.json',
  envHDR: null,                     // e.g. './assets/env/dusk_1k.hdr' — RoomEnvironment is used when null
  dracoPath: './vendor/three/addons/libs/draco/gltf/',
  modelRadius: 2.9,                 // every model is normalised to this bounding-sphere radius
  target: new THREE.Vector3(0, 1.25, 0),
  fov: 34,
  thumbSize: 160,
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ui = createUI({ reducedMotion });
const sky = createTimeOfDay();

// Offline support (sw.js). ?nosw skips it, which is handy while editing files locally.
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[sw]', e)));
}

/* ------------------------------------------------------------ quality tiers */

const TIERS = {
  high:   { particles: 60000, maxDpr: 2,    shadows: true,  shadowSize: 2048, dust: 1600, antialias: true },
  medium: { particles: 32000, maxDpr: 1.5,  shadows: true,  shadowSize: 1024, dust: 900,  antialias: true },
  low:    { particles: 14000, maxDpr: 1,    shadows: false, shadowSize: 512,  dust: 400,  antialias: false },
};

/** Pre-renderer guess from device signals; refined once we can read the GPU string. */
function guessTier() {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced && TIERS[forced]) return { name: forced, forced: true };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (mem <= 2 || cores <= 2) return { name: 'low' };
  if (coarse || mem <= 4 || cores <= 4) return { name: 'medium' };
  return { name: 'high' };
}

function refineTier(tier, renderer) {
  if (tier.forced) return tier.name;
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* ignore */ }
  if (/swiftshader|llvmpipe|software|basic render|mali-[4t]|adreno \(tm\) [2-5]\d\d|powervr|sgx/i.test(gpu)) return 'low';
  if (tier.name === 'high' && /intel|apple m1(?! (pro|max|ultra))|uhd|iris/i.test(gpu)) return 'medium';
  return tier.name;
}

/* ------------------------------------------------------------------- boot */

boot().catch((err) => {
  console.error(err);
  ui.setLoading(1, `Something went wrong while loading: ${err.message}`);
});

async function boot() {
  ui.setLoading(0.05, 'Reading the atlas');
  const res = await fetch(CONFIG.dataUrl);
  if (!res.ok) throw new Error(`Could not load ${CONFIG.dataUrl} (${res.status}). Serve the folder over http — see README.`);
  const data = await res.json();
  const wonders = data.wonders;
  ui.showLoaderFact(wonders);

  const startIndex = Math.max(0, wonders.findIndex((w) => `#${w.id}` === location.hash));

  /* --- renderer (with graceful no-WebGL fallback) ----------------------- */
  const guess = guessTier();
  const canvas = document.getElementById('scene');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: TIERS[guess.name].antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch (e) {
    console.warn('WebGL unavailable, running UI-only.', e);
    return bootWithout3D(wonders, startIndex);
  }
  const tierName = refineTier(guess, renderer);
  const tier = TIERS[tierName];
  document.documentElement.dataset.quality = tierName;

  let dpr = Math.min(devicePixelRatio || 1, tier.maxDpr);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = tier.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r18x: PCFSoftShadowMap was folded into PCF

  /* --- scene, camera, controls ----------------------------------------- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CONFIG.fov, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(6.5, 4.2, 9.5);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(CONFIG.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.7;
  controls.minPolarAngle = Math.PI * 0.18;
  controls.maxPolarAngle = Math.PI * 0.5;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  /* --- environment ------------------------------------------------------ */
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.55;
  if (CONFIG.envHDR) {
    new HDRLoader().load(CONFIG.envHDR, (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      envMap = pmrem.fromEquirectangular(hdr).texture;
      scene.environment = envMap;
      hdr.dispose();
    });
  }

  /* --- lights ----------------------------------------------------------- */
  const hemi = new THREE.HemisphereLight('#c9d6ff', '#3a2e22', 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight('#ffe2b8', 2.6);
  key.position.set(5.5, 9, 6);
  key.target.position.copy(CONFIG.target);
  key.castShadow = tier.shadows;
  key.shadow.mapSize.setScalar(tier.shadowSize);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -5; sc.right = sc.top = 5; sc.near = 1; sc.far = 30;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  scene.add(key, key.target);

  const rim = new THREE.DirectionalLight('#8fb3ff', 1.1);
  rim.position.set(-7, 4, -6);
  scene.add(rim);

  /* --- ground: shadow catcher + survey ring ---------------------------- */
  const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.38, transparent: true });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(9, 64), shadowMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const ring = createSurveyRing();
  scene.add(ring);

  const dust = createDust(tier.dust, mulberry32(7));
  scene.add(dust);

  /* --- stage ------------------------------------------------------------ */
  const pivot = new THREE.Group();
  pivot.position.copy(CONFIG.target);
  scene.add(pivot);
  const stage = new THREE.Group();
  stage.position.y = -CONFIG.target.y;
  pivot.add(stage);

  /* --- particles -------------------------------------------------------- */
  let particles = null;
  if (!reducedMotion) {
    particles = new THREE.Points(
      createParticleGeometry(tier.particles, mulberry32(42)),
      createParticleMaterial({ size: 0.055, count: tier.particles })
    );
    particles.frustumCulled = false;
    particles.visible = false;
    particles.renderOrder = 2;
    stage.add(particles);
  }

  /* --- UI --------------------------------------------------------------- */
  let controller = null;
  const extras = createExtras(() => controller?.next());
  ui.init(wonders, extras.handlers({
    select: (i) => controller?.goTo(i),
    next: () => controller?.next(),
    prev: () => controller?.prev(),
  }));

  /* --- build the wonders ----------------------------------------------- */
  const entries = [];
  for (let i = 0; i < wonders.length; i++) {
    const w = wonders[i];
    ui.setLoading(0.1 + (i / wonders.length) * 0.7, `Raising ${w.name}`);
    await nextFrame(); // let the loader paint between builds
    entries.push(prepareModel(buildProceduralWonder(w.id), w, tier.particles));
    entries[i].data = w;
    entries[i].root.visible = false;
    stage.add(entries[i].root);
  }

  // Compile every program now so the first transitions don't hitch.
  ui.setLoading(0.85, 'Lighting the scene');
  entries.forEach((e) => (e.root.visible = true));
  if (particles) particles.visible = true;
  renderer.compile(scene, camera);
  entries.forEach((e) => (e.root.visible = false));
  if (particles) particles.visible = false;

  ui.setLoading(0.92, 'Drawing thumbnails');
  await nextFrame();
  const thumbs = renderThumbnails(renderer, entries, envMap);
  ui.setThumbnails(thumbs);

  /* --- controller ------------------------------------------------------- */
  const view = { dolly: 1 };
  // Per-wonder framing: orbit height and a distance scale, tweened on travel.
  // Portrait screens are width-limited, so wide wonders don't get the close-up.
  const fitScale = (f) => (innerWidth < innerHeight ? Math.max(f.scale, 0.98) : f.scale);
  const framing = { y: entries[startIndex].frame.y, scale: fitScale(entries[startIndex].frame) };
  controller = new MorphController({
    particles,
    stage,
    entries,
    ui,
    view,
    shadowMaterial,
    scatter: scatterCloud(tier.particles, 7, mulberry32(3)),
    reducedMotion,
    onTheme: (theme, duration, entry) => {
      applyLook(entry.data, duration);
      if (entry) gsap.to(framing, { y: entry.frame.y, scale: fitScale(entry.frame), duration: duration * 1.1, ease: 'power2.inOut' });
    },
  });
  // ?debug exposes internals in the console: __atlas.controller.timeline.pause(1.2), etc.
  if (new URLSearchParams(location.search).has('debug')) {
    window.__atlas = { THREE, gsap, scene, camera, renderer, controls, controller, entries, framing, tier: tierName };
  }
  controller.onChange(({ data, phase }) => {
    if (phase === 'start') {
      history.replaceState(null, '', `#${data.id}`);
      extras.ambience.swell();
    }
    if (phase === 'end') extras.tour.arrived();
  });

  // The wonder's palette, shifted to the time of day there (live or a preview).
  let shown = wonders[startIndex];
  const KEY_DISTANCE = 13;
  function applyLook(w, duration) {
    shown = w;
    const theme = w.theme;
    const { look } = sky.show(w, duration);
    const ease = 'power2.inOut';
    tweenColor(key.color, look.key, duration);
    gsap.to(key, { intensity: look.keyIntensity, duration, ease });
    gsap.to(key.position, {
      x: CONFIG.target.x + look.keyDir.x * KEY_DISTANCE,
      y: CONFIG.target.y + look.keyDir.y * KEY_DISTANCE,
      z: CONFIG.target.z + look.keyDir.z * KEY_DISTANCE,
      duration, ease,
    });
    tweenColor(hemi.color, look.hemiSky, duration);
    gsap.to(hemi, { intensity: look.hemiIntensity, duration, ease });
    gsap.to(rim, { intensity: look.rimIntensity, duration, ease });
    gsap.to(scene, { environmentIntensity: look.envIntensity, duration, ease });
    gsap.to(renderer, { toneMappingExposure: 0.88 + 0.17 * look.day, duration, ease });
    const a = new THREE.Color(theme.accent);
    gsap.to(ring.material.color, { r: a.r, g: a.g, b: a.b, duration });
    const p = new THREE.Color(theme.particle);
    gsap.to(dust.material.uniforms.uColor.value, { r: p.r, g: p.g, b: p.b, duration });
  }
  sky.onChange = () => applyLook(shown, 1.6);
  // Live mode: let the sun keep moving while you stay on one wonder.
  setInterval(() => {
    if (document.hidden) return;
    if (sky.mode === 'live' && !controller.busy) applyLook(shown, 8);
    else sky.show(shown, 0, { labelOnly: true });
  }, 60000);

  /* --- layout / resize -------------------------------------------------- */
  let baseDistance = 10;
  let firstLayout = true;
  function layout() {
    const w = innerWidth, h = innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;

    // Fit the model's bounding sphere into the area the UI leaves free.
    const ins = ui.layoutInsets();
    const freeW = Math.max(200, w - ins.left - ins.right);
    const freeH = Math.max(200, h - ins.top - ins.bottom);
    const tanV = Math.tan(THREE.MathUtils.degToRad(CONFIG.fov / 2));
    const halfV = Math.atan(tanV * (freeH / h));
    const halfH = Math.atan(tanV * (freeW / h));
    const R = CONFIG.modelRadius * 0.92;   // the sphere is conservative; allow a little overlap
    baseDistance = Math.max(R / Math.sin(halfV), R / Math.sin(halfH));

    controls.minDistance = baseDistance * 0.5;
    controls.maxDistance = baseDistance * 1.6;
    if (firstLayout) {
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, baseDistance);
      firstLayout = false;
    }

    // Shift the projection so the model is centred in the free area.
    camera.setViewOffset(w, h, (ins.right - ins.left) / 2, (ins.bottom - ins.top) / 2, w, h);
    camera.updateProjectionMatrix();

    const scale = renderer.getDrawingBufferSize(new THREE.Vector2()).y / 2;
    if (particles) particles.material.uniforms.uScale.value = scale;
    dust.material.uniforms.uScale.value = scale;
  }
  layout();
  let resizeRaf = 0;
  addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(layout);
  });

  /* --- pointer parallax ------------------------------------------------- */
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    look.tx = (e.clientX / innerWidth - 0.5) * 2;
    look.ty = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { look.tx = look.ty = 0; });

  let interacting = false, resumeAt = 0;
  controls.addEventListener('start', () => { interacting = true; extras.tour.stop(); });
  controls.addEventListener('end', () => { interacting = false; resumeAt = timer.getElapsed() + 2.5; });

  /* --- render loop ------------------------------------------------------ */
  const timer = new THREE.Timer();
  timer.connect(document); // pauses delta accumulation while the tab is hidden
  let spin = 0, lastDolly = 1;
  const perf = { frames: 0, time: 0 };
  const offset = new THREE.Vector3();

  function frame(timestamp) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();

    // Parallax tilt of the whole stage, eased towards the cursor.
    const k = 1 - Math.exp(-dt * 3.5);
    look.x += (look.tx - look.x) * k;
    look.y += (look.ty - look.y) * k;
    pivot.rotation.y = look.x * 0.16;
    pivot.rotation.x = look.y * 0.06;

    // Slow showcase rotation (paused while the user is orbiting) and float.
    if (!reducedMotion && !interacting && t > resumeAt) spin += dt * 0.1;
    stage.rotation.y = spin;
    stage.position.y = -CONFIG.target.y + (reducedMotion ? 0 : Math.sin(t * 0.7) * 0.05);
    ring.rotation.z = -spin * 0.5;

    // Apply per-wonder framing and the transition "dolly" on top of the
    // user's own zoom: divide the old multiplier out, let OrbitControls work
    // in user space, then multiply the new one back in.
    offset.copy(camera.position).sub(controls.target).divideScalar(lastDolly);
    controls.target.y = framing.y;
    camera.position.copy(controls.target).add(offset);
    controls.update(dt);
    const mult = view.dolly * framing.scale;
    offset.copy(camera.position).sub(controls.target).multiplyScalar(mult);
    camera.position.copy(controls.target).add(offset);
    lastDolly = mult;

    if (particles) particles.material.uniforms.uTime.value = t;
    dust.material.uniforms.uTime.value = t;

    renderer.render(scene, camera);

    // Adaptive resolution: if we're consistently under ~42 fps, step DPR down.
    perf.frames++; perf.time += dt;
    if (perf.time > 2.5) {
      const ms = (perf.time / perf.frames) * 1000;
      if (ms > 24 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); layout(); }
      perf.frames = 0; perf.time = 0;
    }
  }
  renderer.setAnimationLoop(frame);
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : frame);
  });

  /* --- go --------------------------------------------------------------- */
  ui.setLoading(1, 'Ready');
  applyLook(wonders[startIndex], 0.01);
  ui.hideLoader();
  controller.intro(startIndex);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ui.showNo3D(); });

  // Background: replace stand-ins with real models where the JSON lists one.
  loadGLBModels({ renderer, camera, scene, entries, wonders, controller, tier, startIndex, envMap, ui });
}

/* -------------------------------------------------------------- pipeline */

/**
 * Patch materials for dissolve, sample the point cloud. Works on any
 * normalised root (procedural or GLTF).
 */
function prepareModel(root, wonder, count, cloud = null) {
  const dissolve = applyDissolve(root, { edgeColor: wonder.theme.particle });
  return {
    root,
    dissolve,
    frame: frameFor(root, wonder.model?.frameScale ?? 1),
    cloud: cloud ?? samplePointCloud(root, count, { tint: wonder.theme.particle, tintAmount: 0.3, seed: seedFrom(wonder.id) }),
  };
}

async function loadGLBModels({ renderer, camera, scene, entries, wonders, controller, tier, startIndex, envMap, ui }) {
  const queue = wonders
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.model?.glb)
    .sort((a, b) => Math.abs(a.i - startIndex) - Math.abs(b.i - startIndex)); // nearest first
  if (!queue.length) return;

  const draco = new DRACOLoader().setDecoderPath(CONFIG.dracoPath);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  for (const { w, i } of queue) {
    try {
      // Smaller LOD for phones and weaker GPUs when one is provided.
      const url = tier.particles < TIERS.high.particles && w.model.glbMobile ? w.model.glbMobile : w.model.glb;
      const gltf = await loader.loadAsync(url);
      const model = gltf.scene;
      model.rotation.y = THREE.MathUtils.degToRad(w.model.rotationY || 0);
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m.map) m.map.anisotropy = Math.min(8, maxAniso); });
      });
      const root = normalizeModel(model, CONFIG.modelRadius);

      // Optional pre-baked cloud from the Blender script (Float32 xyz, model space).
      let cloud = null;
      if (w.model.points) {
        const buf = await (await fetch(w.model.points)).arrayBuffer();
        const raw = fitCount(new Float32Array(buf), tier.particles, mulberry32(seedFrom(w.id)));
        model.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        for (let k = 0; k < raw.length; k += 3) {
          v.set(raw[k], raw[k + 1], raw[k + 2]).applyMatrix4(model.matrixWorld);
          raw[k] = v.x; raw[k + 1] = v.y; raw[k + 2] = v.z;
        }
        const col = new THREE.Color(w.theme.particle);
        const colors = new Float32Array(raw.length);
        for (let k = 0; k < colors.length; k += 3) colors.set([col.r, col.g, col.b], k);
        cloud = { positions: raw, colors };
      }

      const parts = prepareModel(root, w, tier.particles, cloud);
      await renderer.compileAsync(root, camera, scene);
      controller.replaceModel(i, parts);
      const [thumb] = renderThumbnails(renderer, [{ ...parts, data: w }], envMap);
      ui.setThumbnails(Object.assign([], { [i]: thumb }));
    } catch (err) {
      console.warn(`[models] ${w.name}: keeping the procedural stand-in.`, err);
    }
  }
}

/** UI-only mode when WebGL is unavailable: navigation and content still work. */
function bootWithout3D(wonders, startIndex) {
  ui.showNo3D();
  let current = startIndex;
  const extras = createExtras(() => show(current + 1));
  const show = (i, dir = 1) => {
    const prev = wonders[current];
    current = ((i % wonders.length) + wonders.length) % wonders.length;
    const w = wonders[current];
    sky.show(w, 0.6);
    ui.travel(prev, w, 0.01);
    ui.enter(w, current, dir);
    history.replaceState(null, '', `#${w.id}`);
    extras.tour.arrived();
  };
  ui.init(wonders, extras.handlers({ select: (i) => show(i), next: () => show(current + 1), prev: () => show(current - 1, -1) }));
  sky.onChange = () => sky.show(wonders[current], 1.2);
  setInterval(() => { if (!document.hidden) sky.show(wonders[current], 4); }, 60000);
  ui.travel(null, wonders[current], 0.01);
  show(current);
  ui.hideLoader();
}

/* ---------------------------------------------------------------- extras */

/**
 * Guided tour and ambient sound. Any navigation the user makes themselves
 * stops the tour; the tour's own steps go straight to `advance`.
 */
function createExtras(advance) {
  const ambience = createAmbience();
  const tour = createTour({ advance, onState: ui.setTour });
  if (ambience.remembered) {
    // Audio needs a gesture: honour a remembered "on" at the first click or key.
    ui.setSound(true);
    const arm = () => {
      removeEventListener('pointerdown', arm, true);
      removeEventListener('keydown', arm, true);
      ambience.set(true);
    };
    addEventListener('pointerdown', arm, true);
    addEventListener('keydown', arm, true);
  }
  const user = (fn) => (...args) => { tour.stop(); fn(...args); };
  return {
    tour,
    ambience,
    handlers: (nav) => ({
      select: user(nav.select),
      next: user(nav.next),
      prev: user(nav.prev),
      tour: () => tour.toggle(),
      sound: () => ui.setSound(ambience.toggle()),
      time: () => sky.cycle(),
    }),
  };
}

/* ------------------------------------------------------------ time of day */

/**
 * Which sky to show: "live" (the real sun at the wonder, now) or one of the
 * preview presets. ?time=sunrise|midday|sunset|night starts on a preset.
 * show() sets the CSS sky and the headline clock; main.js does the lights.
 */
function createTimeOfDay() {
  const param = new URLSearchParams(location.search).get('time');
  let mode = param in PREVIEWS ? param : 'live';
  const self = {
    onChange: null,
    get mode() { return mode; },
    cycle() {
      mode = PREVIEW_ORDER[(PREVIEW_ORDER.indexOf(mode) + 1) % PREVIEW_ORDER.length];
      self.onChange?.();
    },
    show(w, duration, { labelOnly = false } = {}) {
      const sun = sunAt(w, mode);
      const look = skyState(w.theme, sun);
      ui.setTime({ local: localTime(w), phase: phaseOf(sun), mode, altitude: sun.altitude });
      if (!labelOnly) {
        gsap.to(document.documentElement, {
          '--sky-top': look.skyTop,
          '--sky-bottom': look.skyBottom,
          '--accent': w.theme.accent,
          '--stars': look.stars,
          duration,
          ease: 'power2.inOut',
        });
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', look.skyTop);
      }
      return { sun, look };
    },
  };
  return self;
}

/* ---------------------------------------------------------------- helpers */

/**
 * How to frame a model: orbit around its vertical centre, and scale camera
 * distance by its largest visible extent relative to the reference radius
 * (flat, wide wonders and tall, narrow ones both fill the view).
 */
function frameFor(root, frameScale = 1) {
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.z, size.y * 1.2) / 2;
  return {
    y: THREE.MathUtils.clamp(size.y * 0.45, 0.6, 2.2),
    scale: THREE.MathUtils.clamp(extent / (CONFIG.modelRadius * 0.92), 0.6, 1.1) * frameScale,
  };
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function tweenColor(color, hex, duration) {
  const c = new THREE.Color(hex);
  gsap.to(color, { r: c.r, g: c.g, b: c.b, duration, ease: 'power2.inOut' });
}

/** Thin compass ring with degree ticks on the ground — the "survey" motif. */
function createSurveyRing() {
  const pts = [];
  const R = 3.6;
  for (let i = 0; i < 360; i += 2) {
    const a0 = THREE.MathUtils.degToRad(i), a1 = THREE.MathUtils.degToRad(i + 2);
    pts.push(Math.cos(a0) * R, Math.sin(a0) * R, 0, Math.cos(a1) * R, Math.sin(a1) * R, 0);
    const len = i % 30 === 0 ? 0.26 : i % 10 === 0 ? 0.14 : 0.06;
    pts.push(Math.cos(a0) * R, Math.sin(a0) * R, 0, Math.cos(a0) * (R + len), Math.sin(a0) * (R + len), 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: '#d2b77c', transparent: true, opacity: 0.22, depthWrite: false })
  );
  lines.rotation.x = -Math.PI / 2;
  lines.position.y = 0.005;
  return lines;
}

/**
 * Render each model to an offscreen target and return PNG data URLs.
 * Render targets are linear and un-tone-mapped, so we encode to sRGB by hand.
 */
function renderThumbnails(renderer, entries, envMap) {
  const S = CONFIG.thumbSize * 2; // supersample, then downscale on a 2D canvas
  const rt = new THREE.WebGLRenderTarget(S, S, { colorSpace: THREE.LinearSRGBColorSpace });
  const tScene = new THREE.Scene();
  tScene.environment = envMap;
  tScene.environmentIntensity = 0.7;
  tScene.add(new THREE.HemisphereLight('#dfe6ff', '#4a3a2a', 0.9));
  const sun = new THREE.DirectionalLight('#fff0dc', 3.2);
  sun.position.set(5, 8, 7);
  tScene.add(sun);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(7.2, 4.6, 8.6);
  cam.lookAt(0, 1.35, 0);

  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const c = Math.min(1, (i / 255) * 1.15); // a touch of exposure
    lut[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  }
  const big = document.createElement('canvas');
  big.width = big.height = S;
  const bctx = big.getContext('2d');
  const small = document.createElement('canvas');
  small.width = small.height = CONFIG.thumbSize;
  const sctx = small.getContext('2d');
  const buf = new Uint8Array(S * S * 4);

  const prevClear = renderer.getClearAlpha();
  const out = entries.map((e) => {
    try {
      const parent = e.root.parent, vis = e.root.visible, dv = e.dissolve.uDissolve.value;
      tScene.add(e.root);
      e.root.visible = true;
      const f = e.frame ?? { y: 1.35, scale: 1 };
      cam.position.set(7.2, 4.6, 8.6).multiplyScalar(f.scale * 0.95);
      cam.position.y += f.y - 1.35;
      cam.lookAt(0, f.y, 0);
      e.dissolve.uDissolve.value = 0;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(tScene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
      renderer.setRenderTarget(null);
      parent ? parent.add(e.root) : tScene.remove(e.root);
      e.root.visible = vis;
      e.dissolve.uDissolve.value = dv;

      const img = bctx.createImageData(S, S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const src = ((S - 1 - y) * S + x) * 4, dst = (y * S + x) * 4;
          img.data[dst] = lut[buf[src]];
          img.data[dst + 1] = lut[buf[src + 1]];
          img.data[dst + 2] = lut[buf[src + 2]];
          img.data[dst + 3] = buf[src + 3];
        }
      }
      bctx.putImageData(img, 0, 0);
      sctx.clearRect(0, 0, small.width, small.height);
      sctx.drawImage(big, 0, 0, small.width, small.height);
      return small.toDataURL('image/png');
    } catch (err) {
      console.warn('Thumbnail failed', err);
      renderer.setRenderTarget(null);
      return null;
    }
  });
  renderer.setClearColor(0x000000, prevClear);
  rt.dispose();
  return out;
}
