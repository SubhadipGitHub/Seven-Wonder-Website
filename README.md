# New Seven Wonders — interactive 3D atlas

A single-page Three.js site that travels between the New Seven Wonders of the World. Each wonder burns away into particles, the particles spin up into a vortex, and they settle into the next wonder while the sky, light, coordinates and information card travel with them.

It runs immediately with procedural stand-in models. Real `.glb` models drop in through `data/wonders.json` without code changes.

## Run it

ES modules don't load from `file://`, so serve the folder:

```bash
# any one of these, from this folder
npx serve .
python -m http.server 5173
```

Then open http://localhost:5173 (or the port `serve` prints). No install, no build: Three.js r186 and GSAP 3.15 are vendored in `vendor/`, so it also works offline and behind proxies that block CDNs. The only external request is Google Fonts, which falls back to system serif/sans if blocked.

Useful URL options:

- `#taj-mahal` (any wonder id) opens on that wonder; the hash updates as you travel.
- `?quality=high|medium|low` overrides the automatic GPU tier.
- `?debug` exposes internals as `window.__atlas` (e.g. `__atlas.controller.timeline.pause(1.2)` to freeze a transition).

## Controls

Desktop: scroll wheel, arrow keys, number keys 1–7 or the thumbnail rail to travel. Drag to orbit, Ctrl + scroll (or trackpad pinch) to zoom. Mouse movement tilts the stage.

Mobile: drag to orbit, pinch to zoom, swipe the title left/right to travel, tap the handle to open the details sheet, menu button for the full list.

## Files

```
index.html               semantic overlay, import map, Tailwind + styles
styles.css               design tokens, glass components, desktop panel / mobile sheet layout
tailwind.css             precompiled Tailwind v4 utilities used by index.html and js/
tailwind.input.css       Tailwind entry for rebuilding
data/wonders.json        content + per-wonder theme + model paths
js/main.js               boot, renderer, lights, environment, controls, render loop, resize, GLB pipeline
js/MorphController.js    transition state machine and GSAP timeline (3D + UI together)
js/morphShader.js        particle vertex/fragment shaders, mesh dissolve patch, dust
js/pointCloud.js         area-weighted surface sampling, seeded PRNG
js/proceduralWonders.js  the seven primitive-built fallback models
js/ui.js                 rail, drawer, card, headline, coordinates, input handling
tools/blender_export_wonders.py   batch LOD + Draco export + point clouds from Blender
docs/BLUEPRINT.md        asset pipeline, architecture, shader walkthrough
vendor/                  three.js (+ Draco decoder) and GSAP, unmodified
assets/models/           put .glb / .usdz / .points.bin files here
assets/env/              optional .hdr environment
```

## Replacing a stand-in with a real model

1. Export from Blender (see `docs/BLUEPRINT.md` §1, or run `tools/blender_export_wonders.py`).
2. In `data/wonders.json`, set the wonder's `model`:

```json
"model": {
  "glb": "assets/models/taj-mahal.glb",
  "glbMobile": "assets/models/taj-mahal.mobile.glb",
  "usdz": "assets/models/taj-mahal.usdz",
  "points": "assets/models/taj-mahal.points.bin",
  "rotationY": 0,
  "frameScale": 1
}
```

Only `glb` is required. Models load in the background after the intro, nearest wonder first, and cross-dissolve in place of the stand-in; if a file fails to load, the stand-in stays and a warning goes to the console. Scale and position don't matter — every model is normalised to the same bounding sphere with its base on the ground. Use `rotationY` (degrees) to turn its best side to the camera and `frameScale` (< 1 = closer) if it reads small.

"View in AR" uses AR Quick Look on iOS (needs `usdz`) and Google Scene Viewer on Android (needs `glb` on a public HTTPS URL). Elsewhere, or without files, the button explains what's missing instead of failing silently.

To use your own HDR lighting, put a 1k–2k `.hdr` in `assets/env/` and set `CONFIG.envHDR` at the top of `js/main.js`.

## Rebuilding Tailwind

`tailwind.css` is compiled from the classes in `index.html` and `js/`. If you add new utility classes:

```bash
npx @tailwindcss/cli -i ./tailwind.input.css -o ./tailwind.css --minify
```

For quick prototyping you can instead swap the `tailwind.css` link for the browser build noted in `index.html` (`@tailwindcss/browser@4.3.3` from jsDelivr). It compiles in the browser on every load, so don't ship it.

## Decisions worth knowing

- **Vanilla ES modules, not React Three Fiber.** One scene, one transition, a dozen objects: R3F would add a build step and a framework runtime without paying for itself. See BLUEPRINT §2.
- **Custom input controller, not ScrollTrigger.** A fixed viewport with a draggable canvas and real document scroll fight each other on touch screens. Wheel/keys/swipes map to discrete steps instead.
- **Vendored libraries, precompiled Tailwind.** The request said "Tailwind via CDN"; the Play CDN is explicitly not for production (runtime compile, flash of unstyled content), and CDNs are a single point of failure behind corporate firewalls. The CDN swap is one line if you want it.
- **Particles and meshes, not one or the other.** At rest you see a lit, shadowed PBR mesh; the particles only exist during the transition, so the noise-heavy vertex shader costs nothing the rest of the time.

## Open questions

- **Real models.** Licensing is on you: most good photogrammetry scans of these sites (Sketchfab, CyArk, museum collections) are CC-BY or non-commercial. Check before you ship.
- **Sound.** A low wind swell under the vortex would sell the transition; left out because autoplay audio needs a user gesture and a mute control.
- **Analytics / hosting.** Static files, so any host works; nothing here phones home.

## Browser support

Current Chrome, Edge, Firefox and Safari (import maps, WebGL2, `color-mix()`). Without WebGL the page still loads and all content and navigation work, with a note where the 3D view would be. `prefers-reduced-motion` swaps the particle vortex for a short cross-dissolve and stops the idle spin.

## Credits

Three.js (MIT), GSAP (GreenSock standard license, free), simplex noise by Ashima Arts / Stefan Gustavson (MIT). Facts in `data/wonders.json` are drawn from UNESCO World Heritage listings and standard references; the dates and figures shown are the commonly cited ones, and a few (e.g. capacity estimates) are ranges in the literature.
