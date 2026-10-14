/**
 * proceduralWonders.js
 * ---------------------------------------------------------------------------
 * Out-of-the-box stand-ins for the seven wonders and the honorary Great
 * Pyramid, built only from Three.js primitives (boxes, cylinders, lathes,
 * extrusions). They exist so the site runs immediately; drop a Draco .glb
 * into assets/models/ and point data/wonders.json at it to replace any of them.
 *
 * Each builder returns a THREE.Group in arbitrary units. finalize() merges
 * every mesh by material (a whole wonder renders in 3–6 draw calls) and
 * normalizeModel() fits the result to a common bounding sphere, with its base
 * at y = 0, so procedural and GLTF models are framed identically.
 *
 * Meshes tagged userData.noParticles (ground, terrain, water) are rendered
 * but excluded from the particle point cloud, so the cloud reads as the
 * monument rather than the landscape.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ helpers */

const matCache = new Map();
function mat(hex, roughness = 0.85, { metalness = 0, flat = false } = {}) {
  const key = `${hex}|${roughness}|${metalness}|${flat}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color: hex, roughness, metalness, flatShading: flat }));
  }
  // Each wonder gets its own clones (dissolve uniforms are per wonder).
  return matCache.get(key).clone();
}

/** Add a mesh with a transform. `o` = {x,y,z, rx,ry,rz, sx,sy,sz, s, np} */
function add(group, geo, material, o = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(o.x || 0, o.y || 0, o.z || 0);
  m.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0);
  if (o.s) m.scale.setScalar(o.s);
  else m.scale.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.np) m.userData.noParticles = true;
  group.add(m);
  return m;
}

/** Add a mesh with an explicit world matrix. */
function addM(group, geo, material, matrix, np = false) {
  const m = new THREE.Mesh(geo, material);
  m.matrixAutoUpdate = false;
  m.matrix.copy(matrix);
  if (np) m.userData.noParticles = true;
  group.add(m);
  return m;
}

const box = (w, h, d, ws = 1, hs = 1, ds = 1) => new THREE.BoxGeometry(w, h, d, ws, hs, ds);
const cyl = (rt, rb, h, seg = 16, hs = 1, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, hs, open);

/** Deterministic hash → [-1, 1]; depends only on position so seams don't crack. */
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Roughen a geometry (rock, cliffs). Displacement is a pure function of position. */
function jitter(geo, amount, { keepBase = true } = {}) {
  const p = geo.attributes.position;
  const v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = keepBase && v.y <= geo.boundingBox?.min.y + 1e-4 ? 0.3 : 1;
    const qx = Math.round(v.x * 1000) / 1000, qy = Math.round(v.y * 1000) / 1000, qz = Math.round(v.z * 1000) / 1000;
    p.setXYZ(
      i,
      v.x + hash3(qx, qy, qz) * amount * k,
      v.y + hash3(qy, qz, qx) * amount * 0.6 * k,
      v.z + hash3(qz, qx, qy) * amount * k
    );
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Extruded 2D shape. Shape lies in XY; extrusion goes along +Z, centred. */
function extrude(shape, depth, curveSegments = 12) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Triangular prism: base width `w`, height `h`, length `len` along Z. */
function prism(w, h, len, skew = 0) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(skew, h);
  s.closePath();
  return extrude(s, len);
}

/** Pointed (Mughal) arch panel: width w, total height h, springing at hs. */
function pointedArchShape(w, h, hs) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(-w / 2, hs);
  s.quadraticCurveTo(-w / 2, h * 0.94, 0, h);
  s.quadraticCurveTo(w / 2, h * 0.94, w / 2, hs);
  s.lineTo(w / 2, 0);
  s.closePath();
  return s;
}

/** Lathe from [radius, height] pairs. */
function lathe(points, segments = 32) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** Onion dome profile (unit: base radius 1, height ~2.2). */
const ONION = [
  [1.0, 0], [1.08, 0.1], [1.17, 0.3], [1.21, 0.52], [1.18, 0.76], [1.06, 1.0],
  [0.86, 1.25], [0.6, 1.5], [0.36, 1.72], [0.17, 1.92], [0.07, 2.08], [0.0, 2.2],
];
const onion = (r, segs = 32) => lathe(ONION.map(([x, y]) => [x * r, y * r]), segs);

/**
 * Surface swept around concentric ellipses: profile = [{a, b, y}, ...].
 * Used for the Colosseum's stepped seating and arena floor.
 */
function ellipticSweep(profile, segments = 72) {
  const pos = [];
  const uv = [];
  const ring = (k, t) => {
    const p = profile[k];
    return [Math.cos(t) * p.a, p.y, Math.sin(t) * p.b];
  };
  for (let k = 0; k < profile.length - 1; k++) {
    for (let s = 0; s < segments; s++) {
      const t0 = (s / segments) * TAU, t1 = ((s + 1) / segments) * TAU;
      const a = ring(k, t0), b = ring(k, t1), c = ring(k + 1, t1), d = ring(k + 1, t0);
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Basis matrix: X along `dir`, Y roughly up, origin at `p`. */
function frame(p, dir) {
  const x = dir.clone().normalize();
  const z = new V3().crossVectors(x, new V3(0, 1, 0)).normalize();
  const y = new V3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(p);
}
const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);

/* ===================================================== 1. Great Wall ====== */

function greatWall() {
  const g = new THREE.Group();
  const stone = mat('#b8a07a', 0.88);
  const stoneTop = mat('#a08a64', 0.9);
  const hill = mat('#566b48', 1, { flat: true });

  const path = (t) =>
    new V3(
      -3.3 + t * 6.6,
      0.62 + Math.sin(t * Math.PI * 2.1 + 0.3) * 0.42 + Math.sin(t * Math.PI * 5.3) * 0.1,
      Math.sin(t * Math.PI * 1.5 + 0.5) * 1.05
    );

  // Ridge terrain that follows the wall's path; crest sits just under the wall.
  const S = 90, K = 12, half = 1.45;
  const verts = [], idx = [];
  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const p = path(t), p2 = path(Math.min(1, t + 0.01)), p1 = path(Math.max(0, t - 0.01));
    const dir = p2.sub(p1).setY(0).normalize();
    const side = new V3(-dir.z, 0, dir.x);
    for (let j = 0; j <= K; j++) {
      const u = (j / K) * 2 - 1;
      const fall = 1 - Math.pow(Math.abs(u), 1.5);
      const h = (p.y - 0.06) * fall + hash3(i * 0.37, j * 0.71, 1.3) * 0.05 * fall;
      verts.push(p.x + side.x * u * half, Math.max(0, h), p.z + side.z * u * half);
    }
  }
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < K; j++) {
      const a = i * (K + 1) + j, b = a + K + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const ridge = new THREE.BufferGeometry();
  ridge.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  ridge.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((verts.length / 3) * 2).fill(0), 2));
  ridge.setIndex(idx);
  ridge.computeVertexNormals();
  add(g, ridge, hill, { np: true });

  // Wall segments with crenellations on both parapets.
  const N = 70;
  const wallH = 0.2, wallW = 0.2;
  for (let i = 0; i < N; i++) {
    const a = path(i / N), b = path((i + 1) / N);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const F = frame(mid, dir);
    addM(g, box(len * 1.04, wallH, wallW), stone, F.clone().multiply(T(0, wallH / 2 - 0.04, 0)));
    addM(g, box(len * 1.04, 0.02, wallW * 0.8), stoneTop, F.clone().multiply(T(0, wallH - 0.03, 0)));
    const count = Math.max(1, Math.round(len / 0.075));
    for (let k = 0; k < count; k++) {
      const lx = -len / 2 + (k + 0.5) * (len / count);
      for (const sz of [-1, 1]) {
        addM(g, box(0.04, 0.05, 0.025), stone, F.clone().multiply(T(lx, wallH - 0.015, sz * (wallW / 2 - 0.012))));
      }
    }
  }

  // Watchtowers.
  for (let i = 4; i < N; i += 11) {
    const p = path(i / N), q = path((i + 1) / N);
    const dir = q.clone().sub(p).setY(0);
    const F = frame(p, dir);
    const tw = 0.34, th = 0.42;
    addM(g, box(tw, th, tw), stone, F.clone().multiply(T(0, th / 2 - 0.06, 0)));
    addM(g, box(tw + 0.03, 0.03, tw + 0.03), stoneTop, F.clone().multiply(T(0, th - 0.06, 0)));
    for (let k = 0; k < 4; k++) {
      const o = -tw / 2 + 0.04 + k * ((tw - 0.08) / 3);
      for (const [x, z] of [[o, -tw / 2 + 0.015], [o, tw / 2 - 0.015], [-tw / 2 + 0.015, o], [tw / 2 - 0.015, o]]) {
        addM(g, box(0.045, 0.055, 0.045), stone, F.clone().multiply(T(x, th - 0.03, z)));
      }
    }
    // small guardhouse on alternate towers
    if (i % 2 === 0) addM(g, box(0.14, 0.1, 0.14), stoneTop, F.clone().multiply(T(0, th + 0.0, 0)));
    // dark window slits
    addM(g, box(0.06, 0.1, tw + 0.004), mat('#3a3024', 1), F.clone().multiply(T(0, th * 0.5, 0)));
  }
  return g;
}

/* ========================================================== 2. Petra ====== */

function petra() {
  const g = new THREE.Group();
  const rock = mat('#b9765d', 0.95, { flat: true });
  const facade = mat('#d69a7c', 0.85);
  const shade = mat('#9d5e48', 0.9);
  const dark = mat('#2c1611', 1);
  const sand = mat('#c99a74', 1, { flat: true });

  // Cliff mass behind and around the façade.
  const back = box(5.2, 4.6, 1.4, 12, 10, 3); back.computeBoundingBox(); jitter(back, 0.08);
  add(g, back, rock, { y: 2.3, z: -0.95 });
  for (const sx of [-1, 1]) {
    const side = box(1.0, 4.6, 1.5, 3, 10, 4); side.computeBoundingBox(); jitter(side, 0.09);
    add(g, side, rock, { x: sx * 2.15, y: 2.3, z: 0.05 });
  }
  const crown = box(5.2, 0.7, 1.7, 12, 2, 4); crown.computeBoundingBox(); jitter(crown, 0.1);
  add(g, crown, rock, { y: 4.7, z: -0.3 });

  // Plaza.
  add(g, box(5.6, 0.12, 2.6, 8, 1, 4), sand, { y: -0.06, z: 0.9, np: true });

  // Recessed façade wall.
  add(g, box(3.3, 4.1, 0.2), shade, { y: 2.05, z: -0.15 });

  // Lower storey.
  add(g, box(3.4, 0.14, 0.75), facade, { y: 0.07, z: 0.2 });
  add(g, box(3.2, 0.06, 0.65), facade, { y: 0.17, z: 0.2 });
  const colH = 1.5, colY = 0.2;
  for (const x of [-1.35, -0.92, -0.42, 0.42, 0.92, 1.35]) {
    add(g, cyl(0.085, 0.095, colH, 18), facade, { x, y: colY + colH / 2, z: 0.3 });
    add(g, box(0.22, 0.12, 0.22), facade, { x, y: colY + colH + 0.06, z: 0.3 });
    add(g, box(0.22, 0.06, 0.22), facade, { x, y: colY + 0.03, z: 0.3 });
  }
  add(g, box(0.55, 1.05, 0.06), dark, { y: 0.72, z: -0.03 });   // doorway
  add(g, box(3.25, 0.3, 0.55), facade, { y: 1.98, z: 0.27 });   // entablature
  add(g, box(3.35, 0.05, 0.6), facade, { y: 2.15, z: 0.27 });
  add(g, prism(1.5, 0.42, 0.42), facade, { y: 2.17, z: 0.27 }); // pediment

  // Upper storey.
  add(g, box(3.3, 0.12, 0.5), facade, { y: 2.65, z: 0.15 });
  // Central tholos: ring of columns, drum, conical roof, urn.
  const tY = 2.71;
  add(g, cyl(0.36, 0.36, 1.05, 24), shade, { y: tY + 0.52, z: 0.1 });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    if (Math.sin(a) < -0.5) continue; // hidden back columns
    add(g, cyl(0.045, 0.05, 1.0, 10), facade, { x: Math.cos(a) * 0.46, y: tY + 0.5, z: 0.1 + Math.sin(a) * 0.46 });
  }
  add(g, cyl(0.53, 0.53, 0.12, 28), facade, { y: tY + 1.06, z: 0.1 });
  add(g, new THREE.ConeGeometry(0.5, 0.36, 28), facade, { y: tY + 1.3, z: 0.1 });
  add(g, cyl(0.05, 0.08, 0.12, 12), facade, { y: tY + 1.54, z: 0.1 });
  add(g, new THREE.SphereGeometry(0.12, 16, 12), facade, { y: tY + 1.68, z: 0.1, sy: 1.2 });
  // Side pavilions with broken half-pediments that rise toward the centre.
  for (const sx of [-1, 1]) {
    for (const x of [0.85, 1.45]) add(g, cyl(0.05, 0.055, 0.95, 12), facade, { x: sx * x, y: tY + 0.48, z: 0.22 });
    add(g, box(0.82, 0.14, 0.38), facade, { x: sx * 1.15, y: tY + 1.02, z: 0.2 });
    add(g, prism(0.82, 0.28, 0.36, sx * -0.41), facade, { x: sx * 1.15, y: tY + 1.09, z: 0.2 });
    add(g, box(0.4, 0.78, 0.04), dark, { x: sx * 1.15, y: tY + 0.42, z: 0.0 });
  }
  return g;
}

/* ============================================ 3. Christ the Redeemer ====== */

function christRedeemer() {
  const g = new THREE.Group();
  const rock = mat('#596652', 1, { flat: true });
  const rock2 = mat('#465440', 1, { flat: true });
  const forest = mat('#3e5a3a', 1, { flat: true });
  const plinth = mat('#bdb6a6', 0.8);
  const soap = mat('#cfd3c8', 0.62);

  // Corcovado: a truncated, roughened peak with a forested shoulder.
  const peak = cyl(0.42, 1.9, 2.6, 10, 7); peak.computeBoundingBox(); jitter(peak, 0.12);
  add(g, peak, rock, { y: 1.3 });
  const shoulder = cyl(0.8, 1.7, 1.3, 9, 4); shoulder.computeBoundingBox(); jitter(shoulder, 0.12);
  add(g, shoulder, forest, { x: 0.9, y: 0.65, z: 0.45, np: true });
  const spur = cyl(0.5, 1.2, 1.7, 8, 4); spur.computeBoundingBox(); jitter(spur, 0.12);
  add(g, spur, rock2, { x: -0.9, y: 0.85, z: -0.4, np: true });

  // Viewing platform and pedestal (with chapel inside, as on the real one).
  const top = 2.6;
  add(g, box(0.95, 0.08, 0.95), plinth, { y: top + 0.04 });
  add(g, box(0.5, 0.6, 0.5), plinth, { y: top + 0.38 });
  add(g, box(0.58, 0.05, 0.58), plinth, { y: top + 0.7 });

  // Statue: lathe robe, arms, sleeves, head.
  const y0 = top + 0.72;
  const robe = lathe([
    [0, 0], [0.24, 0], [0.25, 0.08], [0.23, 0.55], [0.2, 1.1], [0.19, 1.45], [0.215, 1.62],
    [0.235, 1.74], [0.2, 1.81], [0.1, 1.86], [0.065, 1.9], [0.0, 1.92],
  ], 28);
  add(g, robe, soap, { y: y0, sz: 0.72 });
  const armY = y0 + 1.7;
  add(g, box(2.05, 0.11, 0.13), soap, { y: armY });
  for (const sx of [-1, 1]) {
    add(g, box(0.5, 0.28, 0.12), soap, { x: sx * 0.38, y: armY - 0.15 });  // sleeve near body
    add(g, box(0.42, 0.16, 0.1), soap, { x: sx * 0.78, y: armY - 0.08 });  // sleeve hanging
    add(g, box(0.07, 0.15, 0.05), soap, { x: sx * 1.04, y: armY - 0.03 }); // hand
  }
  add(g, cyl(0.05, 0.06, 0.08, 12), soap, { y: y0 + 1.94 });
  add(g, new THREE.SphereGeometry(0.11, 20, 16), soap, { y: y0 + 2.07, sy: 1.15 });
  return g;
}

/* =================================================== 4. Machu Picchu ====== */

function machuPicchu() {
  const g = new THREE.Group();
  const mount = mat('#4d7448', 1, { flat: true });
  const peakM = mat('#3c5e3f', 1, { flat: true });
  const grass = mat('#79a463', 0.95);
  const wall = mat('#9c988c', 0.9);
  const wallDark = mat('#7e7a70', 0.95);
  const thatch = mat('#b59658', 1);

  const base = cyl(1.75, 2.8, 1.3, 11, 4); base.computeBoundingBox(); jitter(base, 0.1);
  add(g, base, mount, { y: 0.65, np: true });
  add(g, box(2.7, 0.1, 1.7), grass, { y: 1.33 });

  // Agricultural terraces stepping down the front slope.
  for (let i = 0; i < 7; i++) {
    const w = 2.75 - i * 0.12;
    const y = 1.24 - i * 0.165;
    const z = 0.92 + i * 0.19;
    add(g, box(w, 0.035, 0.2), grass, { y, z });
    add(g, box(w, 0.16, 0.035), wall, { y: y - 0.08, z: z + 0.1 });
  }
  // and down the left flank
  for (let i = 0; i < 5; i++) {
    const y = 1.24 - i * 0.18, x = -1.42 - i * 0.18;
    add(g, box(0.2, 0.035, 1.4 - i * 0.08), grass, { x, y, z: 0.1 });
    add(g, box(0.035, 0.17, 1.4 - i * 0.08), wall, { x: x - 0.1, y: y - 0.085, z: 0.1 });
  }

  // Roofless granite rooms; a few reconstructed with thatch.
  const rooms = [
    [-0.95, -0.45, 0.42, 0.3, 1], [-0.45, -0.5, 0.34, 0.26, 0], [0.05, -0.55, 0.4, 0.28, 1],
    [0.55, -0.5, 0.36, 0.3, 0], [1.0, -0.42, 0.34, 0.26, 0], [-0.9, 0.05, 0.3, 0.3, 0],
    [0.95, 0.12, 0.38, 0.28, 1], [0.48, 0.38, 0.3, 0.24, 0], [-0.4, 0.42, 0.34, 0.22, 0],
    [-1.05, 0.5, 0.28, 0.24, 1],
  ];
  const fy = 1.38, wh = 0.17, t = 0.03;
  for (const [x, z, w, d, roof] of rooms) {
    add(g, box(w, wh, t), wall, { x, y: fy + wh / 2, z: z - d / 2 });
    add(g, box(w, wh, t), wall, { x, y: fy + wh / 2, z: z + d / 2 });
    add(g, box(t, wh, d), wall, { x: x - w / 2, y: fy + wh / 2, z });
    add(g, box(t, wh, d), wall, { x: x + w / 2, y: fy + wh / 2, z });
    // gable ends
    add(g, prism(d, 0.12, t), wallDark, { x: x - w / 2, y: fy + wh, z, ry: Math.PI / 2 });
    add(g, prism(d, 0.12, t), wallDark, { x: x + w / 2, y: fy + wh, z, ry: Math.PI / 2 });
    if (roof) add(g, prism(d + 0.08, 0.15, w + 0.06), thatch, { x, y: fy + wh, z, ry: Math.PI / 2 });
  }
  // Intihuatana platform
  add(g, box(0.22, 0.12, 0.22), wallDark, { x: 0.1, y: fy + 0.06, z: 0.0 });
  add(g, box(0.07, 0.12, 0.05), wall, { x: 0.1, y: fy + 0.18, z: 0.0 });

  // Huayna Picchu and its neighbour behind the citadel.
  const hp = new THREE.ConeGeometry(0.72, 3.0, 9, 6); hp.computeBoundingBox(); jitter(hp, 0.1);
  add(g, hp, peakM, { x: 0.35, y: 1.5, z: -1.75 });
  const hp2 = new THREE.ConeGeometry(1.0, 1.9, 9, 4); hp2.computeBoundingBox(); jitter(hp2, 0.12);
  add(g, hp2, mount, { x: -0.9, y: 0.95, z: -1.9, np: true });
  return g;
}

/* =================================================== 5. Chichén Itzá ====== */

function chichenItza() {
  const g = new THREE.Group();
  const lime = mat('#d3c6a6', 0.9);
  const band = mat('#b7a785', 0.9);
  const dark = mat('#2a2219', 1);
  const lawn = mat('#7e8f57', 1);

  add(g, box(5.4, 0.06, 5.4), lawn, { y: -0.03, np: true });

  const tiers = 9, H = 2.0, bw = 3.2, tw = 1.25;
  const th = H / tiers;
  for (let i = 0; i < tiers; i++) {
    const w = bw - (i * (bw - tw)) / (tiers - 1);
    add(g, box(w, th * 0.9, w), lime, { y: i * th + th * 0.45 });
    add(g, box(w + 0.03, th * 0.18, w + 0.03), band, { y: i * th + th * 0.8 });
  }

  // Four stairways: solid stepped prisms (24 steps standing in for 91).
  const steps = 24, sw = 0.56;
  const start = bw / 2 + 0.3, end = tw / 2;
  const run = (start - end) / steps, rise = H / steps;
  const slope = Math.hypot(start - end, H);
  const ang = Math.atan2(H, start - end);
  for (let side = 0; side < 4; side++) {
    const R = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
    for (let k = 0; k < steps; k++) {
      const h = (k + 1) * rise;
      const d = start - (k + 0.5) * run;
      addM(g, box(sw, h, run * 1.02), lime, R.clone().multiply(T(0, h / 2, d)));
    }
    // balustrades + serpent heads
    for (const sx of [-1, 1]) {
      const mid = new V3(sx * (sw / 2 + 0.04), H / 2 + 0.04, (start + end) / 2);
      const M = R.clone().multiply(T(mid.x, mid.y, mid.z)).multiply(new THREE.Matrix4().makeRotationX(ang));
      addM(g, box(0.08, 0.1, slope), band, M);
      addM(g, box(0.13, 0.12, 0.2), band, R.clone().multiply(T(sx * (sw / 2 + 0.04), 0.06, start + 0.05)));
    }
  }

  // Temple of Kukulcán on the summit.
  add(g, box(1.0, 0.56, 1.0), lime, { y: H + 0.28 });
  add(g, box(1.1, 0.08, 1.1), band, { y: H + 0.6 });
  add(g, box(0.9, 0.1, 0.9), lime, { y: H + 0.69 });
  for (let side = 0; side < 4; side++) {
    const R = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
    const doors = side === 0 ? [-0.27, 0, 0.27] : [0];
    for (const x of doors) addM(g, box(0.17, 0.32, 0.03), dark, R.clone().multiply(T(x, H + 0.2, 0.505)));
  }
  return g;
}

/* ====================================================== 6. Colosseum ====== */

function colosseum() {
  const g = new THREE.Group();
  const trav = mat('#d9c39e', 0.85);
  const travDark = mat('#bfa57f', 0.9);
  const brick = mat('#a6735a', 0.95);
  const arena = mat('#c7ab82', 1);
  const pit = mat('#5b4637', 1);

  const A = 2.3, B = 1.9;               // outer ellipse semi-axes (189 m × 156 m)
  const N = 56;                          // arches per ring
  const TH = 0.42, depth = 0.17;         // tier height, wall depth
  const segW = 13.3 / N;                 // ≈ perimeter / N

  // One arch block: a wall panel with a round-headed opening.
  const archBlock = (w, h, ow, spring, d) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0);
    s.lineTo(-ow / 2, 0);
    s.lineTo(-ow / 2, spring);
    s.absarc(0, spring, ow / 2, Math.PI, 0, true);
    s.lineTo(ow / 2, 0);
    s.lineTo(w / 2, 0);
    s.lineTo(w / 2, h);
    s.lineTo(-w / 2, h);
    s.closePath();
    return extrude(s, d, 8);
  };
  const ARCH = archBlock(segW * 1.03, TH, segW * 0.56, TH * 0.5, depth);
  const ATTIC = box(segW * 1.03, TH * 0.85, depth);
  const BAND = box(segW * 1.06, 0.035, depth + 0.05);
  const HALFCOL = cyl(0.022, 0.024, TH * 0.9, 8);

  const placeOnEllipse = (a, b, t, y) => {
    const x = Math.cos(t) * a, z = Math.sin(t) * b;
    const tx = -Math.sin(t) * a, tz = Math.cos(t) * b;
    const yaw = Math.atan2(-tz, tx);
    return new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
  };

  // The collapsed southern stretch of the outer ring (earthquake of 1349).
  const ruinHeight = (t) => {
    const c = 4.4, w = 0.95;                        // centre angle, half-width (rad)
    const d = Math.abs(((t - c + Math.PI) % TAU + TAU) % TAU - Math.PI);
    if (d > w) return 4;                            // intact: 3 arcades + attic
    const edge = (w - d) / w;                       // 0 at break → 1 in middle
    return edge < 0.18 ? 3 : edge < 0.36 ? 2 : 1;   // stepped break
  };

  for (let i = 0; i < N; i++) {
    const t = ((i + 0.5) / N) * TAU;
    const levels = ruinHeight(t);
    for (let L = 0; L < Math.min(levels, 3); L++) {
      const M = placeOnEllipse(A, B, t, L * TH);
      addM(g, ARCH, trav, M);
      addM(g, BAND, travDark, M.clone().multiply(T(0, TH, 0)));
      addM(g, HALFCOL, travDark, M.clone().multiply(T(segW / 2, TH * 0.45, depth / 2 + 0.01)));
    }
    if (levels === 4) {
      const M = placeOnEllipse(A, B, t, 3 * TH);
      addM(g, ATTIC, trav, M.clone().multiply(T(0, TH * 0.425, 0)));
      addM(g, BAND, travDark, M.clone().multiply(T(0, TH * 0.86, 0)));
      if (i % 2 === 0) addM(g, box(segW * 0.3, TH * 0.22, 0.02), pit, M.clone().multiply(T(0, TH * 0.45, depth / 2 + 0.005)));
    }
  }

  // Inner ring, exposed where the outer wall has fallen.
  const A2 = A - 0.36, B2 = B - 0.36;
  const ARCH2 = archBlock(segW * 0.88, TH, segW * 0.46, TH * 0.5, depth * 0.9);
  for (let i = 0; i < N; i++) {
    const t = ((i + 0.5) / N) * TAU;
    if (ruinHeight(t) === 4) continue;
    for (let L = 0; L < 3; L++) addM(g, ARCH2, brick, placeOnEllipse(A2, B2, t, L * TH));
    addM(g, BAND, travDark, placeOnEllipse(A2, B2, t, 3 * TH));
  }

  // Stepped seating (cavea) between the arena wall and the inner ring.
  const prof = [];
  const rows = 9;
  for (let r = 0; r <= rows; r++) {
    const f = r / rows;
    const a = 1.12 + f * (A2 - 1.18), b = 0.74 + f * (B2 - 0.8);
    const y = 0.2 + f * (TH * 3 - 0.25);
    prof.push({ a, b, y });
    if (r < rows) prof.push({ a: a + (A2 - 1.18) / rows, b: b + (B2 - 0.8) / rows, y });
  }
  const seatMat = brick.clone(); seatMat.side = THREE.DoubleSide;
  add(g, ellipticSweep(prof, 80), seatMat);

  // Arena: podium wall, partial wooden floor, exposed hypogeum walls.
  const podium = mat('#cdb48d', 0.9); podium.side = THREE.DoubleSide;
  add(g, ellipticSweep([{ a: 1.12, b: 0.74, y: 0.0 }, { a: 1.12, b: 0.74, y: 0.2 }], 80), podium);
  add(g, ellipticSweep([{ a: 0, b: 0, y: 0.01 }, { a: 1.12, b: 0.74, y: 0.01 }], 80), pit, { np: true });
  add(g, box(0.95, 0.03, 1.3), arena, { x: 0.55, y: 0.13 });
  for (let k = -3; k <= 3; k++) {
    const len = 1.9 * Math.sqrt(Math.max(0, 1 - (k / 3.6) ** 2));
    add(g, box(len * 0.55, 0.12, 0.025), travDark, { x: -0.5, y: 0.07, z: k * 0.17 });
  }
  return g;
}

/* ====================================================== 7. Taj Mahal ====== */

function tajMahal() {
  const g = new THREE.Group();
  const marble = mat('#efe9df', 0.32);
  const marbleShade = mat('#d6cdbf', 0.45);
  const inlay = mat('#b9ab96', 0.5);
  const red = mat('#9b5a45', 0.85);
  const water = mat('#24384c', 0.06, { metalness: 0.85 });
  const lawn = mat('#5e7c4a', 1);

  // Plinth.
  add(g, box(4.1, 0.36, 4.1), marble, { y: 0.18 });
  add(g, box(4.2, 0.04, 4.2), inlay, { y: 0.37 });

  // Garden front: lawns, walkway and the reflecting pool (not in the particle cloud).
  add(g, box(4.1, 0.05, 1.7), red, { y: 0.0, z: 2.9, np: true });
  for (const sx of [-1, 1]) add(g, box(1.55, 0.06, 1.6), lawn, { x: sx * 1.15, y: 0.03, z: 2.9, np: true });
  add(g, box(0.5, 0.04, 1.6), marbleShade, { y: 0.03, z: 2.9, np: true });
  add(g, box(0.3, 0.02, 1.5), water, { y: 0.06, z: 2.9, np: true });

  // Mausoleum: square with chamfered corners.
  const s = 2.0, c = 0.32, H = 1.55, y0 = 0.38;
  const plan = new THREE.Shape();
  const h2 = s / 2;
  plan.moveTo(-h2 + c, -h2);
  plan.lineTo(h2 - c, -h2); plan.lineTo(h2, -h2 + c);
  plan.lineTo(h2, h2 - c); plan.lineTo(h2 - c, h2);
  plan.lineTo(-h2 + c, h2); plan.lineTo(-h2, h2 - c);
  plan.lineTo(-h2, -h2 + c); plan.closePath();
  const body = new THREE.ExtrudeGeometry(plan, { depth: H, bevelEnabled: false });
  body.rotateX(-Math.PI / 2);
  add(g, body, marble, { y: y0 });
  add(g, box(s + 0.06, 0.06, s + 0.06), inlay, { y: y0 + H + 0.03, sx: 0.96, sz: 0.96 });

  // Iwans: a pishtaq frame with a deep pointed arch on each face.
  const bigArch = extrude(pointedArchShape(0.56, 1.15, 0.78), 0.03, 16);
  const smallArch = extrude(pointedArchShape(0.2, 0.55, 0.36), 0.03, 12);
  for (let f = 0; f < 4; f++) {
    const R = new THREE.Matrix4().makeRotationY((f * Math.PI) / 2);
    addM(g, box(0.8, 1.42, 0.05), marble, R.clone().multiply(T(0, y0 + 0.71, h2 + 0.02)));
    addM(g, bigArch, marbleShade, R.clone().multiply(T(0, y0 + 0.08, h2 + 0.05)));
    addM(g, box(0.8, 0.05, 0.06), inlay, R.clone().multiply(T(0, y0 + 1.4, h2 + 0.03)));
    for (const sx of [-1, 1]) {
      for (const yy of [0.1, 0.8]) {
        addM(g, smallArch, marbleShade, R.clone().multiply(T(sx * 0.55, y0 + yy, h2 + 0.02)));
      }
    }
    // chamfered corner faces
    const C = new THREE.Matrix4().makeRotationY((f * Math.PI) / 2 + Math.PI / 4);
    const cd = (h2 - c / 2) * Math.SQRT2;
    for (const yy of [0.1, 0.8]) addM(g, smallArch, marbleShade, C.clone().multiply(T(0, y0 + yy, cd + 0.02)));
  }

  // Drum, onion dome, finial.
  const roof = y0 + H + 0.06;
  add(g, cyl(0.6, 0.62, 0.42, 40), marble, { y: roof + 0.21 });
  add(g, cyl(0.64, 0.64, 0.04, 40), inlay, { y: roof + 0.42 });
  add(g, onion(0.6, 40), marble, { y: roof + 0.42 });
  const domeTop = roof + 0.42 + 0.6 * 2.2;
  add(g, cyl(0.02, 0.03, 0.42, 8), inlay, { y: domeTop + 0.2 });
  add(g, new THREE.SphereGeometry(0.05, 12, 8), inlay, { y: domeTop + 0.12 });
  add(g, new THREE.SphereGeometry(0.035, 12, 8), inlay, { y: domeTop + 0.26 });

  // Chhatris (domed kiosks) at the four roof corners.
  const chhatri = (x, y, z, r) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      add(g, cyl(r * 0.07, r * 0.08, r * 1.3, 6), marble, { x: x + Math.cos(a) * r * 0.8, y: y + r * 0.65, z: z + Math.sin(a) * r * 0.8 });
    }
    add(g, cyl(r * 1.05, r * 1.05, r * 0.15, 16), marble, { x, y: y + r * 1.37, z });
    add(g, onion(r * 0.72, 20), marble, { x, y: y + r * 1.44, z });
    add(g, cyl(r * 0.05, r * 0.05, r * 0.5, 6), inlay, { x, y: y + r * 1.44 + r * 0.72 * 2.2 + r * 0.2, z });
  };
  for (const [x, z] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) chhatri(x, roof, z, 0.2);

  // Minarets at the plinth corners.
  for (const [x, z] of [[-1.88, -1.88], [1.88, -1.88], [-1.88, 1.88], [1.88, 1.88]]) {
    const mH = 2.75;
    add(g, cyl(0.1, 0.14, mH, 20), marble, { x, y: y0 + mH / 2, z });
    for (const f of [0.32, 0.64, 0.97]) {
      add(g, cyl(0.19, 0.17, 0.05, 20), marbleShade, { x, y: y0 + mH * f, z });
      add(g, cyl(0.19, 0.19, 0.06, 20, 1, true), marble, { x, y: y0 + mH * f + 0.05, z });
    }
    chhatri(x, y0 + mH, z, 0.15);
  }
  return g;
}

/* ============================================ 8. Great Pyramid (honorary) = */

function greatPyramid() {
  const g = new THREE.Group();
  const core = mat('#cfb48a', 0.95);
  const coreShade = mat('#b89c72', 0.95);
  const casing = mat('#e2d2b0', 0.8, { flat: true });
  const sand = mat('#a3825a', 1);

  add(g, cyl(2.45, 2.55, 0.06, 48), sand, { y: -0.03, np: true });

  // Khufu: the casing is gone, so the core reads as fine horizontal courses.
  // Real proportions: 230.3 m base, 146.6 m high → 2.3 × 1.466 units.
  const B = 2.3, H = 1.466, courses = 26;
  const ch = H / courses;
  for (let i = 0; i < courses; i++) {
    const w = B * (1 - (i + 0.5) / courses);
    add(g, box(w, ch * 0.92, w), i % 2 ? core : coreShade, { y: i * ch + ch * 0.46 });
  }
  // Capstone stand-in (the real apex is missing — a survey mast marks it).
  add(g, cyl(0, B / courses / Math.SQRT2 * 1.4, ch * 1.4, 4), casing, { y: H - ch * 0.3, ry: Math.PI / 4 });

  // Three queens' pyramids in a row on the east side, still partly cased.
  const q = (x, z, b, h) => add(g, cyl(0, b / Math.SQRT2, h, 4), casing, { x, y: h / 2, z, ry: Math.PI / 4 });
  for (const [z, s] of [[-0.7, 1], [-0.08, 0.96], [0.52, 0.92]]) q(B / 2 + 0.45, z, 0.46 * s, 0.3 * s);
  return g;
}

/* ===================================================== public API ======== */

const BUILDERS = {
  'great-wall': greatWall,
  petra,
  'christ-the-redeemer': christRedeemer,
  'machu-picchu': machuPicchu,
  'chichen-itza': chichenItza,
  colosseum,
  'taj-mahal': tajMahal,
  'great-pyramid': greatPyramid,
};

/**
 * Merge all meshes that share a material into one geometry (world transforms
 * baked in). Keeps noParticles meshes separate so the sampler can skip them.
 */
export function finalize(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  group.traverse((m) => {
    if (!m.isMesh) return;
    const key = m.material.uuid + (m.userData.noParticles ? ':np' : '');
    if (!buckets.has(key)) buckets.set(key, { material: m.material, np: !!m.userData.noParticles, geos: [] });
    let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    geo.clearGroups();
    geo.applyMatrix4(m.matrixWorld);
    buckets.get(key).geos.push(geo);
  });
  const out = new THREE.Group();
  for (const { material, np, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((gg) => gg.dispose());
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (np) mesh.userData.noParticles = true;
    out.add(mesh);
  }
  return out;
}

/**
 * Fit any model (procedural or GLTF) to a bounding sphere of `radius`,
 * centred on X/Z with its base on y = 0. Wraps it in a pivot group so the
 * original transforms are left intact.
 */
export function normalizeModel(object, radius = 2.9) {
  const pivot = new THREE.Group();
  pivot.add(object);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new V3());
  const scale = radius / (size.length() / 2 || 1);
  object.scale.multiplyScalar(scale);
  object.updateMatrixWorld(true);
  box.setFromObject(object);
  const c = box.getCenter(new V3());
  object.position.x -= c.x;
  object.position.z -= c.z;
  object.position.y -= box.min.y;
  pivot.updateMatrixWorld(true);
  return pivot;
}

/** Build the procedural stand-in for a wonder id. */
export function buildProceduralWonder(id) {
  const builder = BUILDERS[id];
  if (!builder) throw new Error(`No procedural builder for "${id}"`);
  return normalizeModel(finalize(builder()));
}

export const PROCEDURAL_IDS = Object.keys(BUILDERS);
