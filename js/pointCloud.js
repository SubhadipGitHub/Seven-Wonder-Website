/**
 * pointCloud.js
 * ---------------------------------------------------------------------------
 * Turns any wonder (procedural or GLTF) into a fixed-size point cloud for the
 * morph. Points are sampled area-weighted over the visible surface with
 * MeshSurfaceSampler, so detail lands where the structure is, and colours are
 * taken from each mesh's material (or the average colour of its base-colour
 * texture), lightly tinted towards the wonder's theme colour.
 *
 * Sampling is seeded per wonder, so the same model always produces the same
 * cloud — that keeps transitions stable across reloads.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

/** Small deterministic PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const seedFrom = (str) => [...str].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);

const avgCache = new WeakMap();
/** Average colour of a texture (downsampled on a 2D canvas). Linear working space. */
function textureAverage(tex) {
  if (!tex?.image) return null;
  if (avgCache.has(tex)) return avgCache.get(tex);
  let out = null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(tex.image, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    out = new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch { /* ImageBitmap without canvas support, tainted canvas, … */ }
  avgCache.set(tex, out);
  return out;
}

/**
 * Sample `count` points from the meshes under `root`.
 * `root` must already be normalised; its own transform is baked in, so the
 * cloud lives in the same space the model will occupy inside the stage.
 */
export function samplePointCloud(root, count, { tint = '#ffffff', tintAmount = 0.3, seed = 1 } = {}) {
  root.updateMatrixWorld(true);
  const tintColor = new THREE.Color(tint);
  const positions = [];
  const colors = [];
  const v = new THREE.Vector3();

  root.traverse((m) => {
    if (!m.isMesh || m.userData.noParticles || !m.visible) return;
    const src = m.geometry;
    const g = src.index ? src.toNonIndexed() : src;
    const p = g.attributes.position;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const baseMat = mats[0];
    const col = (baseMat.color ? baseMat.color.clone() : new THREE.Color(1, 1, 1));
    const texAvg = textureAverage(baseMat.map);
    if (texAvg) col.multiply(texAvg);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      positions.push(v.x, v.y, v.z);
      colors.push(col.r, col.g, col.b);
    }
    if (g !== src) g.dispose();
  });

  if (positions.length === 0) throw new Error('samplePointCloud: no sampleable meshes');

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const rng = mulberry32(seed);
  const sampler = new MeshSurfaceSampler(new THREE.Mesh(merged)).setRandomGenerator(rng).build();
  const outPos = new Float32Array(count * 3);
  const outCol = new Float32Array(count * 3);
  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    sampler.sample(pos, nrm, c);
    // push points a hair off the surface so they don't z-fight the mesh
    pos.addScaledVector(nrm, 0.004);
    outPos.set([pos.x, pos.y, pos.z], i * 3);
    c.lerp(tintColor, tintAmount);
    const jitter = 0.85 + rng() * 0.3;
    outCol.set([c.r * jitter, c.g * jitter, c.b * jitter], i * 3);
  }
  merged.dispose();
  return { positions: outPos, colors: outCol };
}

/**
 * Fit an externally baked cloud (e.g. a .bin from the Blender script) to
 * exactly `count` points by random pick/repeat, so it can join the morph.
 */
export function fitCount(src, count, rng = Math.random, stride = 3) {
  const n = Math.floor(src.length / stride);
  const out = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    const j = n >= count ? Math.floor((i / count) * n) : Math.floor(rng() * n);
    for (let k = 0; k < stride; k++) out[i * stride + k] = src[j * stride + k];
  }
  return out;
}

/** Points scattered in a sphere — the "nothing yet" shape used by the intro. */
export function scatterCloud(count, radius = 7, rng = Math.random) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rng() * 2 - 1, t = rng() * Math.PI * 2, r = radius * Math.cbrt(0.35 + rng() * 0.65);
    const s = Math.sqrt(1 - u * u);
    out[i * 3] = Math.cos(t) * s * r;
    out[i * 3 + 1] = 2 + u * r * 0.6;
    out[i * 3 + 2] = Math.sin(t) * s * r;
  }
  return out;
}
