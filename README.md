# New Seven Wonders — interactive 3D atlas

A single-page Three.js site that travels between the New Seven Wonders of the World. Each wonder burns away into particles, the particles spin up into a vortex, and they settle into the next wonder while the sky, light, coordinates and information card travel with them.

It runs immediately with procedural stand-in models. Real `.glb` models drop in through `data/wonders.json` without code changes.

The Great Pyramid of Giza, given honorary status by the New7Wonders Foundation, comes last in the list and is labelled as honorary rather than numbered.

Each wonder's card has four tabs: **Overview** (key numbers, context, what to look for, materials), **Timeline** (dated milestones), **Facts** (a deck of facts and debunked myths) and **Visit** (getting there, best season, visitor numbers with their year, distance from the last stop, and sources). A small globe in the headline turns to each site and draws the great-circle route as you travel.

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

Desktop: scroll wheel, arrow keys, number keys 1–8 or the thumbnail rail to travel. Drag to orbit, Ctrl + scroll (or trackpad pinch) to zoom. Mouse movement tilts the stage. `T` starts or stops the guided tour, `M` toggles sound, `F` shows another fact, `?` lists every shortcut. Inside the card's tab bar, the arrow keys switch tabs instead of travelling.

Mobile: drag to orbit, pinch to zoom, swipe the title left/right to travel, tap the handle or a tab to open the details sheet, menu button for the full list.

Top bar: **play** runs a guided tour (about 9 s per wonder; any navigation of your own, or orbiting, stops it). **Speaker** turns on an ambient wind bed, synthesised with WebAudio, that swells under each transition; it's off by default and the choice is remembered. **Share** in the card uses the system share sheet on phones and copies the deep link elsewhere.

## Files

```
index.html               semantic overlay, import map, Tailwind + styles, social meta
styles.css               design tokens, glass components, desktop panel / mobile sheet layout
tailwind.css             precompiled Tailwind v4 utilities used by index.html and js/
tailwind.input.css       Tailwind entry for rebuilding
data/wonders.json        content + per-wonder theme + model paths
data/land-110m.json      coastlines for the mini globe (Natural Earth 110m, public domain)
js/main.js               boot, renderer, lights, environment, controls, render loop, resize, GLB pipeline
js/MorphController.js    transition state machine and GSAP timeline (3D + UI together)
js/morphShader.js        particle vertex/fragment shaders, mesh dissolve patch, dust
js/pointCloud.js         area-weighted surface sampling, seeded PRNG
js/proceduralWonders.js  the eight primitive-built fallback models
js/ui.js                 rail, drawer, tabbed card, headline, coordinates, share, input handling
js/globe.js              orthographic mini globe and great-circle travel arc (2D canvas)
js/tour.js               guided-tour timer
js/audio.js              WebAudio ambience (wind bed + transition swell)
assets/favicon.svg, assets/og-image.jpg   tab icon and social preview
tools/blender_export_wonders.py   batch LOD + Draco export + point clouds from Blender
docs/BLUEPRINT.md        asset pipeline, architecture, shader walkthrough
vendor/                  three.js (+ Draco decoder) and GSAP, unmodified
assets/models/           put .glb / .usdz / .points.bin files here
assets/env/              optional .hdr environment
```

## Content schema

Everything a wonder shows comes from its entry in `data/wonders.json`. Beyond `id`, `name`, `country`, `region`, `coordinates`, `built`, `builtBy`, `unesco`, `context`, `highlights`, `theme` and `model`, these optional fields fill the card; a tab hides itself when its fields are missing:

```jsonc
"honorary": true,                       // listed last, labelled instead of numbered
"unescoNote": "Listed as part of …",    // shown under the UNESCO year
"keyStats": [{ "value": "21,196 km", "label": "…" }],      // first one leads; 2–4 work best
"materials": ["Fired brick", "…"],
"timeline": [{ "year": "221 BC", "event": "…" }],
"facts": [
  { "type": "fact", "text": "…" },
  { "type": "myth", "text": "the myth", "truth": "what's actually true" }
],
"visit": { "nearestCity": "…", "bestTime": "…", "visitors": { "value": "1.59 million", "year": 2019 }, "note": "…" },
"sources": [{ "label": "UNESCO World Heritage Centre — …", "url": "https://…" }]
```

The older single-value `stat` and `funFact` fields are still read if `keyStats` / `facts` are absent. Always give visitor figures a year: they move a lot, and several sites (Chichén Itzá, Giza) publish inconsistent counts.

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

If the site isn't served from `https://subhadipgithub.github.io/Seven-Wonder-Website/`, update `og:url` and `og:image` in `index.html` — social cards need absolute URLs.

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
- **Analytics / hosting.** Static files, so any host works; nothing here phones home.

## Browser support

Current Chrome, Edge, Firefox and Safari (import maps, WebGL2, `color-mix()`). Without WebGL the page still loads and all content and navigation work, with a note where the 3D view would be. `prefers-reduced-motion` swaps the particle vortex for a short cross-dissolve and stops the idle spin.

## Credits

Three.js (MIT), GSAP (GreenSock standard license, free), simplex noise by Ashima Arts / Stefan Gustavson (MIT), coastlines from Natural Earth (public domain) via world-atlas. Facts in `data/wonders.json` are drawn from UNESCO World Heritage listings and standard references, and each wonder lists its sources in the Visit tab; the dates and figures shown are the commonly cited ones, and a few (e.g. capacity estimates) are ranges in the literature. Visitor numbers come from the site operators' or ministries' published counts for the year given.
