/**
 * morphShader.js
 * ---------------------------------------------------------------------------
 * All GLSL for the wonder transitions lives here:
 *
 *  1. createParticleMaterial()  – ShaderMaterial for the morphing point cloud.
 *     Every particle carries a "from" position (the `position` attribute) and a
 *     "to" position (`aTo`). One uniform, uProgress (0 → 1), drives the whole
 *     morph. Along the way each particle is spun into a vortex, lifted, pushed
 *     outward and stirred by 3D simplex noise; the strength of all of that
 *     follows a bell curve, so particles leave one shape cleanly and land on
 *     the next one cleanly.
 *
 *  2. applyDissolve()  – patches the PBR materials of a wonder (procedural or
 *     GLTF) via onBeforeCompile, so the solid mesh can burn away with a glowing
 *     edge just as the particles take over, and burn back in at the end.
 *
 *  3. createDustMaterial() – the faint drifting dust field behind the stage.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';

/* 3D simplex noise — Ashima Arts / Stefan Gustavson (MIT). */
export const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x  = x_ * ns.x + ns.yyyy;
  vec4 y  = y_ * ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/* ------------------------------------------------------------------------- */
/* 1. Particle morph                                                          */
/* ------------------------------------------------------------------------- */

export const particleVertexShader = /* glsl */ `
uniform float uTime;
uniform float uProgress;   // 0 = "from" shape, 1 = "to" shape
uniform float uSize;       // world-space point size
uniform float uScale;      // drawingBufferHeight / 2 (perspective size attenuation)
uniform float uOpacity;
uniform float uScatter;    // how far particles fly out during the vortex
uniform float uSwirl;      // total vortex spin in radians at the peak
uniform float uStagger;    // 0..0.6 – spread of per-particle start delays
uniform vec3  uGlow;       // colour particles shift towards mid-flight
uniform float uDensity;    // alpha compensation: more particles → dimmer each, same total glow

attribute vec3 aTo;
attribute vec3 aColorFrom;
attribute vec3 aColorTo;
attribute vec4 aRandom;    // x: delay, y: size/alpha jitter, z: orbit jitter, w: lift jitter

varying vec3  vColor;
varying float vAlpha;

${NOISE_GLSL}

mat2 rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float easeInOutCubic(float t){
  return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5;
}

void main(){
  // Per-particle progress: delays are biased by height so the top of the
  // old wonder lifts off first and the new one assembles from the ground up.
  float heightBias = clamp(1.0 - position.y * 0.25, 0.0, 1.0) * 0.5;
  float delay = (aRandom.x * 0.6 + heightBias * 0.4) * uStagger;
  float p = clamp((uProgress - delay) / (1.0 - uStagger), 0.0, 1.0);
  float e = easeInOutCubic(p);
  float bell = sin(p * 3.14159265);          // 0 → 1 → 0 across the flight

  vec3 pos = mix(position, aTo, e);

  // Vortex: pull every particle into a spinning funnel (narrow at the base,
  // wider with height) at the middle of its flight, then release it onto the
  // new shape. Inner particles spin faster, which gives visible spiral arms.
  float r = length(pos.xz);
  vec2 dirXZ = r > 1e-4 ? pos.xz / r : vec2(1.0, 0.0);
  float lift = bell * uScatter * (0.3 + aRandom.w * 1.1);
  pos.y += lift;
  float funnelR = (0.3 + clamp(pos.y, 0.0, 5.0) * 0.3) * (0.65 + aRandom.z * 0.7);
  float newR = mix(r, funnelR, bell * 0.8 * uScatter);
  float spin = bell * uSwirl * (1.35 - 0.12 * newR + aRandom.z * 0.25) + pos.y * 0.6 * bell;
  pos.xz = rot2(spin) * (dirXZ * newR);

  // Light turbulence so the funnel isn't too perfect.
  vec3 q = pos * 0.55 + vec3(0.0, uTime * 0.35, aRandom.w * 3.0);
  vec3 turb = vec3(snoise(q), snoise(q + 17.31), snoise(q + 41.73));
  pos += turb * bell * uScatter * 0.16;

  // Barely-there breathing so a settled cloud never looks frozen.
  pos += turb * 0.012;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = uSize * (0.55 + aRandom.y * 0.9) * (1.0 + bell * 0.7);
  gl_PointSize = max(size * uScale / -mv.z, 1.0);

  vColor = mix(aColorFrom, aColorTo, e);
  vColor = mix(vColor, uGlow, bell * 0.45);
  vAlpha = uOpacity * uDensity * (0.55 + 0.45 * aRandom.y);
}
`;

export const particleFragmentShader = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;

void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.0, d);
  float a = core * core;
  gl_FragColor = vec4(vColor * (1.0 + core * 1.8), vAlpha * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Build the particle material. Uniform values are mutated directly by
 * MorphController / GSAP.
 */
export function createParticleMaterial({ size = 0.055, scale = 500, count = 20000 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uSize: { value: size },
      uScale: { value: scale },
      uOpacity: { value: 0 },
      uScatter: { value: 1.0 },
      uSwirl: { value: 5.5 },
      uStagger: { value: 0.4 },
      uGlow: { value: new THREE.Color('#ffd89a') },
      uDensity: { value: Math.min(1, Math.sqrt(12000 / count)) },
    },
    vertexShader: particleVertexShader,
    fragmentShader: particleFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Allocate the shared BufferGeometry for the particle system.
 * `count` is fixed for the life of the page (chosen by the quality tier), and
 * every wonder's point cloud is sampled to exactly this count, so a morph is
 * just a copy of two Float32Arrays into the attribute buffers.
 */
export function createParticleGeometry(count, rng = Math.random) {
  const geo = new THREE.BufferGeometry();
  const mk = (n) => new THREE.BufferAttribute(new Float32Array(count * n), n).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', mk(3));
  geo.setAttribute('aTo', mk(3));
  geo.setAttribute('aColorFrom', mk(3));
  geo.setAttribute('aColorTo', mk(3));
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < rnd.length; i++) rnd[i] = rng();
  geo.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 4));
  // Big fixed bounds: the vortex flies outside any single wonder's box.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.5, 0), 12);
  return geo;
}

/* ------------------------------------------------------------------------- */
/* 2. Mesh dissolve (works on Standard / Physical / Lambert / Phong / Basic)  */
/* ------------------------------------------------------------------------- */

/**
 * Patch every material under `root` so it can dissolve.
 * Returns the shared uniform set — tween `uniforms.uDissolve.value`
 * from 0 (solid) to 1 (gone) and back.
 *
 * The dissolve front mixes simplex noise with normalised height, so the
 * structure burns away from the top down and re-forms from the ground up.
 */
export function applyDissolve(root, { edgeColor = '#ffd18a', noiseScale = 3.2 } = {}) {
  const box = new THREE.Box3().setFromObject(root);
  const uniforms = {
    uDissolve: { value: 0 },
    uMinY: { value: box.min.y },
    uMaxY: { value: box.max.y },
    uEdgeColor: { value: new THREE.Color(edgeColor) },
    uEdgeWidth: { value: 0.05 },
    uNoiseScale: { value: noiseScale },
  };

  const patched = new Set();
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      if (!m || patched.has(m)) return;
      patched.add(m);
      patchMaterial(m, uniforms);
    });
  });
  return uniforms;
}

function patchMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDissolvePos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDissolvePos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    const header = /* glsl */ `
#include <common>
varying vec3 vDissolvePos;
uniform float uDissolve;
uniform float uMinY;
uniform float uMaxY;
uniform vec3  uEdgeColor;
uniform float uEdgeWidth;
uniform float uNoiseScale;
${NOISE_GLSL}
`;
    const discardBlock = /* glsl */ `
#include <clipping_planes_fragment>
float dH = clamp((vDissolvePos.y - uMinY) / max(uMaxY - uMinY, 1e-4), 0.0, 1.0);
float dN = snoise(vDissolvePos * uNoiseScale) * 0.5 + 0.5;
float dV = mix(dN, 1.0 - dH, 0.55);            // high value = survives longest
float dT = uDissolve * 1.25 - 0.1;              // threshold sweeps -0.1 → 1.15
if (dV < dT) discard;
float dGlow = (1.0 - smoothstep(dT, dT + uEdgeWidth, dV)) * step(0.001, uDissolve);
`;

    let frag = shader.fragmentShader
      .replace('#include <common>', header)
      .replace('#include <clipping_planes_fragment>', discardBlock);

    if (frag.includes('#include <emissivemap_fragment>')) {
      frag = frag.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uEdgeColor * dGlow * 2.6;'
      );
    } else {
      // MeshBasicMaterial and friends have no emissive term.
      frag = frag.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb += uEdgeColor * dGlow * 3.0;'
      );
    }
    shader.fragmentShader = frag;
  };
  // Keep patched programs separate from any unpatched material of the same type.
  material.customProgramCacheKey = () => 'wonder-dissolve-v1';
  material.needsUpdate = true;
}

/* ------------------------------------------------------------------------- */
/* 3. Ambient dust                                                            */
/* ------------------------------------------------------------------------- */

export function createDust(count, rng = Math.random) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Thick cylindrical shell around the stage, biased upward.
    const r = 5 + rng() * 9;
    const a = rng() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = -1 + rng() * 9;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, 0), 20);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 500 },
      uColor: { value: new THREE.Color('#e9d6a8') },
      uOpacity: { value: 0.55 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uScale;
      attribute float aSeed;
      varying float vTw;
      void main(){
        vec3 p = position;
        p.y = mod(p.y + uTime * (0.05 + aSeed * 0.12) + 1.0, 9.0) - 1.0;
        p.x += sin(uTime * 0.2 + aSeed * 40.0) * 0.3;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max((0.02 + aSeed * 0.035) * uScale / -mv.z, 1.0);
        vTw = 0.35 + 0.65 * abs(sin(uTime * (0.4 + aSeed) + aSeed * 30.0));
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vTw;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * uOpacity * vTw);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = -1;
  return points;
}
