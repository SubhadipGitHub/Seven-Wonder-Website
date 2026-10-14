# Technical blueprint

This covers the asset pipeline (Blender → web), the runtime architecture, and how the morph works. The code it describes is in `js/`; the Blender automation is `tools/blender_export_wonders.py`.

---

## 1. 3D asset and Blender workflow

### 1.1 Poly budgets and LOD

Only one wonder is on screen at a time, so the budget is per model, not per scene.

| Tier | Triangles | Draco .glb size | Textures | Used when |
|---|---|---|---|---|
| LOD0 (desktop) | ≤ 150k | ≤ 3 MB | 2048² base colour, 1024–2048² normal, ORM packed | `high` quality tier |
| LOD1 (mobile) | ≤ 50k | ≤ 1 MB | 1024² base colour, 1024² normal | `medium` / `low` tiers (`model.glbMobile`) |
| Particles | n/a | ≤ 720 KB `.bin` at 60k pts | — | morph only |

Rules of thumb that matter more than the raw numbers:

- **Spend triangles on silhouette.** The model rotates against a plain sky; silhouette is what reads. Flat facades (Petra, the Colosseum's arcades) should be low-poly with detail in the normal map; domes, arches and the Christ statue's drapery need the geometry.
- **Kill hidden geometry.** Interior faces, the underside of the ground, the back of Petra's cliff. Decimation can't tell what the camera never sees; you can.
- **Merge by material.** Aim for ≤ 6 materials per wonder. Every material is a draw call, and the dissolve shader patch is compiled per material type.
- **Model at real-world scale, origin at ground centre, Z-up** (Blender's native). The site normalises every model to the same bounding sphere anyway, but real scale keeps texel density sane.
- Decimate with **Collapse** for organic/terrain meshes and **Planar** (angle ~5°) for architecture; the export script uses Collapse as a safe default — switch per collection if facades smear.

### 1.2 Export as Draco-compressed .glb

Manual export (File → Export → glTF 2.0):

- Format: **glTF Binary (.glb)**
- Include: **Selected Objects**; untick Cameras, Lights (the site lights the scene itself)
- Transform: **+Y Up** on
- Data → Mesh: **Apply Modifiers** on, UVs on, Normals on, Tangents **off** (three.js derives them; saves ~15%)
- Data → Compression: **on**, level **6**, quantisation Position **14**, Normal **10**, Texcoord **12**, Colour **10**, Generic **12**
- Animation: off

Position quantisation 14 bits on a 100 m monument gives ~6 mm precision — invisible. Drop to 12 for mobile if you need the bytes; don't go lower than 11 or flat walls start to ripple.

Automated (all seven, both LODs, plus point clouds):

```bash
blender -b wonders.blend --python tools/blender_export_wonders.py -- \
  --out assets/models --lod0 150000 --lod1 50000 --points 60000
```

The script expects one top-level collection per wonder named with the ids in `data/wonders.json` (`great-wall`, `petra`, …). Decimation is applied as a temporary modifier at export time only; the .blend is not changed. It prints a size report and flags anything over 3 MB.

Textures: the exporter writes PNG/JPEG as authored. For production, run the exported files through glTF-Transform to convert textures to **KTX2 / Basis** (GPU-compressed, ~4–6× less VRAM):

```bash
npx @gltf-transform/cli etc1s assets/models/taj-mahal.glb assets/models/taj-mahal.ktx2.glb
```

ETC1S is right for base colour and ORM; if normal maps show blocky artefacts, encode those with `uastc --slots "normalTexture"` instead.

If you go KTX2, add `KTX2Loader` next to `DRACOLoader` in `main.js` (two lines) and vendor `libs/basis/`.

A note on Draco vs Meshopt: `EXT_meshopt_compression` (via `gltfpack -cc`) usually decodes faster than Draco and compresses UVs/normals better. Draco is used here because it was asked for and is the most common pipeline; for this site — one model at a time, loaded in the background — the difference is not material.

### 1.3 Point clouds for the morph

The morph needs every wonder to have **exactly the same number of points**, so particle *i* of wonder A always has a partner *i* in wonder B. Two ways to get them:

1. **Runtime sampling (default).** `pointCloud.js` merges the model's visible meshes, builds an area-weighted `MeshSurfaceSampler`, and draws N points with a seeded PRNG (same model → same cloud every load). 60k samples take a few tens of ms on a laptop. Colours come from each material's base colour, or the average of its base-colour texture.
2. **Pre-baked (`model.points`).** The Blender script writes `<id>.points.bin`: raw little-endian Float32 `x,y,z` triplets, area-weighted, already converted to glTF Y-up space. Use it when the model is huge (sampler build time) or you want art-directed density — e.g. weight the cloud by a vertex group or use Geometry Nodes → *Distribute Points on Faces* (Poisson Disk) → *Realize Instances* and sample that instead. The site resizes any cloud to its tier's count (`fitCount`).

Mark ground/terrain/water objects with an `NP_` name prefix in Blender (or `userData.noParticles` in code) so the cloud reads as the monument, not the landscape.

Why surface samples and not vertices: vertex density follows modelling topology (a dome has 10× the vertices of a wall of the same area), so a vertex cloud clumps. Area-weighted samples are uniform over the surface.

### 1.4 Materials and lighting for WebGL (PBR)

Use **Principled BSDF only**; the glTF exporter maps it directly to `MeshStandardMaterial`:

| Principled input | glTF / three.js | Notes |
|---|---|---|
| Base Color (+ image) | `baseColorTexture` → `map` (sRGB) | Bake AO into it only if you skip the ORM AO channel |
| Metallic, Roughness | `metallicRoughnessTexture` (B = metal, G = rough) | Pack with AO in R → one "ORM" texture |
| Normal Map node (tangent space) | `normalTexture` | OpenGL convention (Blender's default, = glTF) |
| Emission | `emissiveTexture` | Keep off; the dissolve edge uses emissive |
| Alpha | `alphaMode` | Avoid BLEND on architecture; use MASK for foliage |

Things that don't survive export and should be **baked** first: procedural textures (Noise, Voronoi, Musgrave), Mix Shader setups, displacement, any node not directly feeding Principled. Bake to image textures (Cycles → Bake → Diffuse colour only / Normal / Roughness) on a second UV map, or use the "Simple Bake" add-on.

Lighting is **not** exported. The site lights every wonder the same way so they sit in one world: a warm key `DirectionalLight` with PCF shadows, a cool rim light, a hemisphere fill, and image-based lighting from `RoomEnvironment` through PMREM (or your own `.hdr` via `CONFIG.envHDR`). Preview in Blender with **Eevee**, a 1k–2k dusk HDRI at strength ~0.6, and **Filmic/AgX** view transform close to the site's ACES tone mapping so what you approve is what you get.

---

## 2. Tech stack and architecture

**Choice: plain HTML + ES modules + Three.js + GSAP, no build step.** React Three Fiber would add a build, a framework runtime and a reconciler for a scene with a dozen objects and one stateful transition. Its strengths (component reuse, declarative scene graphs, ecosystem helpers like drei) don't pay off here. Vanilla modules keep the site deployable as static files to any host, and keep the shader and timeline code plain to read.

| Concern | Choice | Where |
|---|---|---|
| 3D engine | Three.js r186 (vendored ES modules) | `vendor/three/` via import map |
| Loaders | `GLTFLoader` + `DRACOLoader` (WASM decoder vendored), `HDRLoader` | `main.js` |
| Controls | `OrbitControls` — drag rotate, pinch / Ctrl+wheel zoom, pan off | `main.js` |
| Morph | `THREE.Points` + custom `ShaderMaterial`; mesh dissolve via `onBeforeCompile` | `morphShader.js` |
| Orchestration | GSAP timelines in a small state machine | `MorphController.js` |
| UI | Semantic HTML, Tailwind utilities (precompiled), glass components in CSS | `index.html`, `styles.css`, `ui.js` |
| Content | `data/wonders.json` | fetched at boot |

**Why not ScrollTrigger.** The page is a single fixed viewport with a draggable canvas. ScrollTrigger needs real document scroll, which on touch devices competes with drag-to-rotate on the same surface, and on desktop hijacks the wheel for scrubbing a timeline that should run on its own clock once started. Instead `ui.js` turns wheel / keys / swipes into discrete *next/prev/select* intents with a lock, and the controller runs a full timeline per step. Ctrl+wheel and trackpad pinch fall through to OrbitControls for zoom.

### Module map

```
index.html ── import map ─┬─ js/main.js            boot, renderer, lights, env, controls, loop, resize, GLB pipeline, thumbnails
                          ├─ js/MorphController.js state machine + GSAP timeline per transition
                          ├─ js/morphShader.js     particle shaders, dissolve patch, dust
                          ├─ js/pointCloud.js      surface sampling, seeded PRNG, cloud resizing
                          ├─ js/proceduralWonders.js  8 fallback models, merge-by-material, normalise
                          ├─ js/ui.js              DOM: rail, drawer, tabbed card, headline, coordinates, input
                          │   └─ js/globe.js       2D-canvas orthographic globe + great-circle arc
                          │   └─ js/quiz.js        "Which wonder?" quiz dialog
                          ├─ js/sky.js             solar position → sky colours, light, stars, local clock
                          ├─ js/tour.js            guided-tour timer
                          └─ js/audio.js           WebAudio wind bed + transition swell
```

### Scene graph

```
scene
 ├─ HemisphereLight, key DirectionalLight (shadows), rim DirectionalLight
 ├─ ground (ShadowMaterial catcher) · survey ring (LineSegments) · dust (Points)
 └─ pivot ............ mouse-parallax tilt, positioned at the orbit target
     └─ stage ........ slow showcase spin + float
         ├─ wonder root ×8 (one visible at rest)
         └─ morph Points (visible only during transitions)
```

### Quality tiers

Picked from `deviceMemory`, `hardwareConcurrency`, pointer type and the unmasked GPU string; overridable with `?quality=high|medium|low`.

| Tier | Particles | DPR cap | Shadows | Dust |
|---|---|---|---|---|
| high | 60,000 | 2 | 2048² PCF | 1,600 |
| medium | 32,000 | 1.5 | 1024² PCF | 900 |
| low | 14,000 | 1 | off | 400 |

At runtime, if the average frame time stays above ~24 ms, the device pixel ratio steps down by 0.25 until it recovers. Particle alpha is scaled by `sqrt(12000 / count)` so every tier glows about the same.

---

## 3. The morph

### Data flow

Every wonder owns `{ root, dissolve uniforms, cloud: { positions, colors } }`. The particle system owns one `BufferGeometry` with fixed-size attributes:

| Attribute | Size | Meaning |
|---|---|---|
| `position` | vec3 | where particle *i* starts (old wonder) |
| `aTo` | vec3 | where it ends (new wonder) |
| `aColorFrom`, `aColorTo` | vec3 | colours at each end |
| `aRandom` | vec4 | per-particle delay, size/alpha jitter, orbit jitter, lift jitter |

Starting a transition is just two `Float32Array.set()` calls into those buffers; the GPU does the rest from a single `uProgress` uniform.

### Vertex shader, in four moves

1. **Stagger.** Each particle gets its own progress: `p = clamp((uProgress − delay) / (1 − uStagger))`, where delay mixes randomness with height so the top of the old wonder lifts first and the new one assembles from the ground up.
2. **Travel.** `pos = mix(from, to, easeInOutCubic(p))`.
3. **Vortex.** A bell curve `sin(p·π)` (0 at both ends, 1 mid-flight) drives everything else: particles are pulled toward a funnel radius that widens with height, spun around Y (inner particles faster, which produces spiral arms), lifted, and stirred by 3D simplex noise.
4. **Size and colour.** Points grow slightly and shift toward the wonder's glow colour mid-flight; additive blending makes overlapping particles bloom without a post-processing pass.

### Mesh dissolve

`applyDissolve()` patches any `MeshStandardMaterial`/`Physical`/`Lambert`/`Phong` (and `Basic`) via `onBeforeCompile`, so it works on GLTF materials untouched. A fragment is discarded when `mix(noise, 1 − height, 0.55) < threshold`; just above the threshold an emissive edge glows. Tweening `uDissolve` 0→1 burns the structure away top-down; 1→0 grows it back bottom-up. Shadows are faded out with the ground catcher's opacity and `castShadow` is toggled, because shadow maps use a separate depth material that doesn't know about the dissolve.

### Timeline (2.8 s)

```
0.00  card + headline leave · shadow fades · particles appear on old shape
0.05  old mesh dissolves (0.95 s)
0.10  particles fly (uProgress 0→1 over 2.4 s); camera eases back ×1.1
0.20  sky gradient, key light, ring colour, framing and coordinates travel
1.60  new headline letters and card content enter
1.75  new mesh re-forms (1.0 s)
2.00  particles fade · shadows return
```

Requests made mid-flight don't queue up: the running timeline is sped up ×3 and only the latest request runs next. With `prefers-reduced-motion`, particles are skipped and the meshes cross-dissolve in under a second; the slow spin and float are switched off.

---

## 4. Performance notes

- The seven procedural wonders render in 3–7 draw calls each (meshes merged per material at build time).
- All shader programs are compiled during the loader (`renderer.compile`), and GLTF swaps use `compileAsync` first, so the first transition doesn't hitch.
- The particle `Points` object is hidden at rest; the noise in its vertex shader costs nothing between transitions.
- The render loop stops while the tab is hidden.
- Thumbnails are rendered from the actual models into an offscreen target at boot (and again when a GLTF arrives), so they always match what's on stage.
