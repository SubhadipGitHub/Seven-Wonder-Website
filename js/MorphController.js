/**
 * MorphController.js
 * ---------------------------------------------------------------------------
 * The state machine that moves the site from one wonder to the next.
 *
 *   idle ──goTo(i)──▶ transitioning ──onComplete──▶ idle
 *                         │   ▲
 *        goTo(j) while    │   │  (timeline sped up ×3, then j runs next;
 *        transitioning ───┘   │   intermediate requests collapse into one)
 *
 * One GSAP timeline per transition orchestrates the 3D and the UI together:
 *
 *   0.00  UI card leaves · shadow fades · particles appear on the old shape
 *   0.05  old mesh burns away top-down (dissolve shader)
 *   0.10  particles lift into the vortex and fly toward the new shape
 *   0.20  sky, lights and coordinates travel to the new wonder
 *   1.60  new UI content enters
 *   1.75  new mesh re-forms bottom-up underneath the settling particles
 *   2.00  particles fade out · shadows return
 *
 * With prefers-reduced-motion the particles are skipped and the two meshes
 * simply cross-dissolve in under a second.
 * ---------------------------------------------------------------------------
 */
import gsap from 'gsap';

export class MorphController {
  /**
   * @param {object} o
   * @param {THREE.Points} o.particles      shared morph point cloud (child of stage)
   * @param {THREE.Object3D} o.stage        parent of all wonder roots
   * @param {Array} o.entries               [{ data, root, dissolve, cloud }]
   * @param {object} o.ui                   UI facade (see ui.js)
   * @param {Function} o.onTheme            (theme, duration) => void
   * @param {object} o.view                 { dolly } — tweened camera-distance multiplier
   * @param {THREE.ShadowMaterial} o.shadowMaterial
   * @param {Float32Array} o.scatter        intro "nothing yet" cloud
   * @param {boolean} o.reducedMotion
   */
  constructor(o) {
    Object.assign(this, o);
    this.current = -1;
    this.busy = false;
    this.pending = null;
    this.timeline = null;
    this.deferredSwaps = new Map();
    this.shadowOpacity = this.shadowMaterial.opacity;
    this.listeners = new Set();
  }

  get count() { return this.entries.length; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  next() { this.goTo((this.current + 1) % this.count); }
  prev() { this.goTo((this.current - 1 + this.count) % this.count); }

  /** Navigate to wonder `index`. Safe to call at any time. */
  goTo(index) {
    index = ((index % this.count) + this.count) % this.count;
    if (this.busy) {
      if (index !== this.target) {
        this.pending = index;
        this.timeline?.timeScale(3);
      }
      return;
    }
    if (index === this.current) return;
    this._run(this.current, index);
  }

  /** First appearance: particles condense out of the dust into `index`. */
  intro(index) {
    this._run(-1, index);
  }

  /**
   * Replace a wonder's model (procedural → GLTF) without breaking state.
   * `parts` = { root, dissolve, cloud }.
   */
  replaceModel(index, parts) {
    if (this.busy) { this.deferredSwaps.set(index, parts); return; }
    const entry = this.entries[index];
    const old = entry.root;
    const oldDissolve = entry.dissolve;
    Object.assign(entry, parts);
    entry.root.visible = index === this.current;
    this.stage.add(entry.root);
    if (index === this.current) this.onTheme(entry.data.theme, 0.9, entry);

    if (index !== this.current) { this._dispose(old); return; }

    // Live swap: cross-dissolve old → new in place.
    entry.dissolve.uDissolve.value = 1;
    this._shadows(entry.root, true);
    gsap.timeline({ onComplete: () => this._dispose(old) })
      .to(oldDissolve.uDissolve, { value: 1, duration: 0.7, ease: 'power2.in' }, 0)
      .to(entry.dissolve.uDissolve, { value: 0, duration: 0.9, ease: 'power2.out' }, 0.35);
  }

  /* ------------------------------------------------------------ internals */

  _run(fromIdx, toIdx) {
    const from = fromIdx >= 0 ? this.entries[fromIdx] : null;
    const to = this.entries[toIdx];
    const dir = fromIdx < 0 ? 1 : Math.sign(this._shortest(fromIdx, toIdx)) || 1;

    this.busy = true;
    this.target = toIdx;
    this.listeners.forEach((fn) => fn({ index: toIdx, data: to.data, phase: 'start' }));

    to.root.visible = true;
    to.dissolve.uDissolve.value = 1;
    this._shadows(to.root, false);

    const tl = gsap.timeline({ onComplete: () => this._settle(fromIdx, toIdx) });
    this.timeline = tl;

    if (this.reducedMotion || !this.particles) {
      this._crossDissolve(tl, from, to, toIdx, dir);
      return;
    }

    this._loadParticleBuffers(from, to);
    const u = this.particles.material.uniforms;
    u.uProgress.value = 0;
    u.uOpacity.value = 0;
    u.uGlow.value.set(to.data.theme.particle);
    this.particles.visible = true;

    const intro = !from;
    const flight = intro ? 3.0 : 2.4;
    const reform = intro ? 2.2 : 1.75;

    if (from) {
      this.ui.leave(dir);
      tl.to(this.shadowMaterial, { opacity: 0, duration: 0.35, ease: 'power1.out' }, 0)
        .call(() => this._shadows(from.root, false), null, 0.35)
        .to(from.dissolve.uDissolve, { value: 1, duration: 0.95, ease: 'power2.in' }, 0.05);
    } else {
      this.shadowMaterial.opacity = 0;
    }

    tl.to(u.uOpacity, { value: 1, duration: intro ? 1.0 : 0.45, ease: 'power1.out' }, 0)
      .to(u.uProgress, { value: 1, duration: flight, ease: 'sine.inOut' }, 0.1)
      .call(() => this.onTheme(to.data.theme, intro ? 1.2 : 2.0, to), null, intro ? 0 : 0.2)
      .call(() => this.ui.travel(from?.data ?? null, to.data, intro ? 2.2 : 2.0), null, 0.2)
      .fromTo(this.view, { dolly: intro ? 1.35 : 1 }, { dolly: intro ? 1 : 1.1, duration: intro ? 3.2 : 1.2, ease: intro ? 'power2.inOut' : 'power2.out' }, 0);
    if (!intro) tl.to(this.view, { dolly: 1, duration: 1.4, ease: 'power2.inOut' }, 1.2);

    tl.call(() => this.ui.enter(to.data, toIdx, dir), null, reform - 0.15)
      .to(to.dissolve.uDissolve, { value: 0, duration: 1.0, ease: 'power2.out' }, reform)
      .to(u.uOpacity, { value: 0, duration: 0.8, ease: 'power1.in' }, reform + 0.25)
      .call(() => this._shadows(to.root, true), null, reform + 0.6)
      .to(this.shadowMaterial, { opacity: this.shadowOpacity, duration: 0.5 }, reform + 0.6);
  }

  _crossDissolve(tl, from, to, toIdx, dir) {
    if (from) {
      this.ui.leave(dir);
      tl.to(from.dissolve.uDissolve, { value: 1, duration: 0.45, ease: 'power1.in' }, 0)
        .call(() => this._shadows(from.root, false), null, 0.2);
    }
    tl.call(() => this.onTheme(to.data.theme, 0.6, to), null, 0)
      .call(() => this.ui.travel(from?.data ?? null, to.data, 0.01), null, 0)
      .call(() => this.ui.enter(to.data, toIdx, dir), null, 0.3)
      .to(to.dissolve.uDissolve, { value: 0, duration: 0.5, ease: 'power1.out' }, 0.3)
      .call(() => this._shadows(to.root, true), null, 0.6);
  }

  _settle(fromIdx, toIdx) {
    if (fromIdx >= 0 && fromIdx !== toIdx) this.entries[fromIdx].root.visible = false;
    if (this.particles) this.particles.visible = false;
    this.shadowMaterial.opacity = this.shadowOpacity;
    this.current = toIdx;
    this.busy = false;
    this.timeline = null;
    this.listeners.forEach((fn) => fn({ index: toIdx, data: this.entries[toIdx].data, phase: 'end' }));

    for (const [i, parts] of this.deferredSwaps) this.replaceModel(i, parts);
    this.deferredSwaps.clear();

    if (this.pending !== null && this.pending !== this.current) {
      const p = this.pending;
      this.pending = null;
      this._run(this.current, p);
    } else {
      this.pending = null;
    }
  }

  /** Copy the from/to clouds into the shared GPU buffers. */
  _loadParticleBuffers(from, to) {
    const a = this.particles.geometry.attributes;
    a.position.array.set(from ? from.cloud.positions : this.scatter);
    if (from) a.aColorFrom.array.set(from.cloud.colors);
    else a.aColorFrom.array.fill(0.35);
    a.aTo.array.set(to.cloud.positions);
    a.aColorTo.array.set(to.cloud.colors);
    a.position.needsUpdate = a.aColorFrom.needsUpdate = a.aTo.needsUpdate = a.aColorTo.needsUpdate = true;
  }

  _shadows(root, on) {
    root.traverse((o) => { if (o.isMesh) o.castShadow = on; });
  }

  _shortest(a, b) {
    const n = this.count;
    let d = b - a;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    return d;
  }

  _dispose(root) {
    root.parent?.remove(root);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        for (const k in m) if (m[k]?.isTexture) m[k].dispose();
        m.dispose();
      });
    });
  }
}
