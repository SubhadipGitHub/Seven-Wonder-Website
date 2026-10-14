/**
 * ui.js
 * ---------------------------------------------------------------------------
 * DOM side of the atlas: builds the thumbnail rail and mobile drawer, fills
 * the information card, animates the headline and the travelling
 * coordinates, and turns input (wheel, keys, swipes) into navigation intents.
 *
 * It never touches Three.js. MorphController calls leave()/travel()/enter()
 * at the right moments of each transition; main.js wires the intents.
 * ---------------------------------------------------------------------------
 */
import gsap from 'gsap';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function createUI({ reducedMotion = false } = {}) {
  const el = {
    loader: $('#loader'),
    loaderFill: $('#loader-fill'),
    loaderStatus: $('#loader-status'),
    name: $('#wonder-name'),
    lat: $('#coord-lat'),
    lng: $('#coord-lng'),
    place: $('#wonder-place'),
    counter: $('#counter-now'),
    card: $('#card'),
    cardInner: $('#card-inner'),
    cardScroll: $('#card-scroll'),
    built: $('#f-built'),
    by: $('#f-by'),
    unesco: $('#f-unesco'),
    statValue: $('#stat-value'),
    statLabel: $('#stat-label'),
    context: $('#f-context'),
    highlights: $('#f-highlights'),
    factBtn: $('#btn-fact'),
    fact: $('#fact'),
    factText: $('#f-fact'),
    arBtn: $('#btn-ar'),
    arNote: $('#ar-note'),
    railList: $('#rail-list'),
    drawer: $('#drawer'),
    drawerList: $('#drawer-list'),
    menuBtn: $('#menu-btn'),
    sheetToggle: $('#sheet-toggle'),
    sheetLabel: $('#sheet-label'),
    status: $('#sr-status'),
    headline: $('#headline'),
    no3d: $('#no3d'),
  };

  let wonders = [];
  let handlers = { select() {}, next() {}, prev() {} };
  let currentData = null;
  const coordState = { lat: 0, lng: 0 };

  /* ------------------------------------------------------------ building */

  function init(list, h) {
    wonders = list;
    handlers = { ...handlers, ...h };
    const thumbVars = (w) => `--t-top:${w.theme.skyTop};--t-bottom:${w.theme.skyBottom}`;

    el.railList.innerHTML = list.map((w, i) => `
      <li><button class="thumb" data-index="${i}" aria-label="${escapeHTML(w.name)}, ${escapeHTML(w.country)}">
        <span class="thumb-img" style="${thumbVars(w)}"></span>
        <span>${escapeHTML(w.name)}</span>
      </button></li>`).join('');

    el.drawerList.innerHTML = list.map((w, i) => `
      <li><button class="drawer-item" data-index="${i}">
        <span class="thumb-img" style="${thumbVars(w)}"></span>
        <span><strong>${escapeHTML(w.name)}</strong><span class="sub">${escapeHTML(w.country)}</span></span>
      </button></li>`).join('');

    $$('[data-index]').forEach((b) =>
      b.addEventListener('click', () => {
        handlers.select(Number(b.dataset.index));
        closeDrawer();
      })
    );
    $$('[data-next]').forEach((b) => b.addEventListener('click', () => handlers.next()));
    $$('[data-prev]').forEach((b) => b.addEventListener('click', () => handlers.prev()));

    el.factBtn.addEventListener('click', toggleFact);
    el.arBtn.addEventListener('click', openAR);
    el.menuBtn.addEventListener('click', openDrawer);
    $$('[data-close]', el.drawer).forEach((b) => b.addEventListener('click', closeDrawer));
    el.sheetToggle.addEventListener('click', () => setSheet(!el.card.classList.contains('is-expanded')));

    bindInput();
  }

  function setThumbnails(urls) {
    urls.forEach((url, i) => {
      if (!url) return;
      $$(`[data-index="${i}"] .thumb-img`).forEach((n) => n.style.setProperty('--thumb', `url("${url}")`));
    });
  }

  /* ------------------------------------------------------------- loading */

  function setLoading(fraction, status) {
    el.loaderFill.style.width = `${Math.round(fraction * 100)}%`;
    if (status) el.loaderStatus.textContent = status;
  }
  function hideLoader() { el.loader.classList.add('is-done'); }
  function showNo3D() { el.no3d.hidden = false; }

  /* --------------------------------------------------- transition phases */

  /** Old content exits in the direction of travel. */
  function leave(dir = 1) {
    if (reducedMotion) return gsap.to([el.cardInner, el.name], { opacity: 0, duration: 0.2 });
    const chars = $$('.char', el.name);
    gsap.to(chars, { yPercent: -110, duration: 0.45, ease: 'power3.in', stagger: { each: 0.012, from: dir > 0 ? 'start' : 'end' } });
    gsap.to([el.place], { opacity: 0, duration: 0.3 });
    gsap.to(el.cardInner, { opacity: 0, x: -24 * dir, duration: 0.4, ease: 'power2.in' });
  }

  /** New content enters. */
  function enter(data, index, dir = 1) {
    currentData = data;
    fillCard(data);
    setName(data.name);
    el.place.textContent = `${data.region}, ${data.country}`;
    el.counter.textContent = String(index + 1);
    el.status.textContent = `Now showing ${data.name}, ${data.country}.`;
    setActive(index);
    el.cardScroll.scrollTop = 0;

    if (reducedMotion) {
      gsap.set([el.cardInner, el.name, el.place], { opacity: 1, x: 0 });
      return;
    }
    gsap.set(el.name, { opacity: 1 });
    gsap.fromTo($$('.char', el.name), { yPercent: 110 }, {
      yPercent: 0, duration: 0.9, ease: 'power4.out', stagger: { each: 0.018, from: dir > 0 ? 'start' : 'end' },
    });
    gsap.fromTo(el.place, { opacity: 0 }, { opacity: 1, duration: 0.6, delay: 0.35 });
    gsap.fromTo(el.cardInner, { opacity: 0, x: 28 * dir }, { opacity: 1, x: 0, duration: 0.7, ease: 'power3.out' });
    gsap.fromTo($$('li', el.highlights), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.07, delay: 0.25, ease: 'power2.out' });
  }

  /** Coordinates count from the old location to the new one. */
  function travel(fromData, toData, duration = 2) {
    const from = fromData ? fromData.coordinates : { lat: 0, lng: 0 };
    gsap.killTweensOf(coordState);
    if (!fromData) Object.assign(coordState, from);
    gsap.to(coordState, {
      lat: toData.coordinates.lat,
      lng: toData.coordinates.lng,
      duration,
      ease: 'power2.inOut',
      onUpdate: renderCoords,
    });
    renderCoords();
  }

  function renderCoords() {
    el.lat.innerHTML = fmtCoord(coordState.lat, 'N', 'S');
    el.lng.innerHTML = fmtCoord(coordState.lng, 'E', 'W');
  }

  function fmtCoord(v, pos, neg) {
    const digits = Math.abs(v).toFixed(4);
    const cells = [...digits].map((c) => (c === '.' ? '.' : `<span class="d">${c}</span>`)).join('');
    return `${cells}°<span class="h">${v >= 0 ? pos : neg}</span>`;
  }

  function setName(name) {
    // Split into word masks → character spans for the per-letter reveal.
    el.name.setAttribute('aria-label', name);
    el.name.innerHTML = name
      .split(' ')
      .map((w) => `<span class="word" aria-hidden="true">${[...w].map((c) => `<span class="char">${c}</span>`).join('')}</span>`)
      .join(' ');
  }

  function fillCard(d) {
    el.built.textContent = d.built;
    el.by.textContent = d.builtBy;
    el.unesco.textContent = String(d.unesco);
    el.statValue.textContent = d.stat.value;
    el.statLabel.textContent = d.stat.label;
    el.context.textContent = d.context;
    el.highlights.innerHTML = d.highlights.map((h) => `<li>${escapeHTML(h)}</li>`).join('');
    el.factText.textContent = d.funFact;
    el.fact.hidden = true;
    el.factBtn.setAttribute('aria-expanded', 'false');
    el.factBtn.textContent = 'Show a fun fact';
    el.arNote.hidden = true;
  }

  function setActive(index) {
    $$('[data-index]').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.index) === index)));
  }

  /* ----------------------------------------------------- fun fact & AR */

  function toggleFact() {
    const open = el.fact.hidden;
    el.fact.hidden = !open;
    el.factBtn.setAttribute('aria-expanded', String(open));
    el.factBtn.textContent = open ? 'Hide the fun fact' : 'Show a fun fact';
    if (open && !reducedMotion) {
      gsap.fromTo(el.fact, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });
      el.fact.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * "View in AR":
   *  - iOS Safari with a .usdz → AR Quick Look
   *  - Android with a .glb     → Google Scene Viewer
   *  - otherwise explain what's needed instead of failing silently.
   */
  function openAR() {
    const m = currentData?.model || {};
    const abs = (p) => new URL(p, location.href).href;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const quickLook = document.createElement('a').relList?.supports?.('ar');

    if (isIOS && quickLook && m.usdz) {
      const a = document.createElement('a');
      a.rel = 'ar';
      a.href = abs(m.usdz);
      a.appendChild(document.createElement('img'));
      a.click();
      return;
    }
    if (isAndroid && m.glb) {
      const file = encodeURIComponent(abs(m.glb));
      const title = encodeURIComponent(currentData.name);
      location.href =
        `intent://arvr.google.com/scene-viewer/1.0?file=${file}&mode=ar_preferred&title=${title}` +
        `#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;` +
        `S.browser_fallback_url=${encodeURIComponent(location.href)};end;`;
      return;
    }
    let msg;
    if (!m.glb && !m.usdz) msg = 'AR needs a 3D model file for this wonder. The model on screen is a lightweight stand-in, so it can’t be placed in your room yet.';
    else if (isIOS && !m.usdz) msg = 'On iPhone and iPad, AR needs a .usdz version of this model.';
    else msg = 'Open this page on an AR-capable phone or tablet to place the model in your room.';
    el.arNote.textContent = msg;
    el.arNote.hidden = false;
  }

  /* --------------------------------------------------- drawer & sheet */

  function openDrawer() {
    el.drawer.hidden = false;
    el.menuBtn.setAttribute('aria-expanded', 'true');
    if (!reducedMotion) {
      gsap.fromTo($('.drawer-panel', el.drawer), { xPercent: 100 }, { xPercent: 0, duration: 0.5, ease: 'power3.out' });
      gsap.fromTo($('.drawer-scrim', el.drawer), { opacity: 0 }, { opacity: 1, duration: 0.4 });
    }
    $('[aria-current="true"]', el.drawerList)?.focus();
  }
  function closeDrawer() {
    if (el.drawer.hidden) return;
    const done = () => { el.drawer.hidden = true; el.menuBtn.setAttribute('aria-expanded', 'false'); };
    if (reducedMotion) return done();
    gsap.to($('.drawer-panel', el.drawer), { xPercent: 100, duration: 0.35, ease: 'power2.in', onComplete: done });
    gsap.to($('.drawer-scrim', el.drawer), { opacity: 0, duration: 0.3 });
  }
  function setSheet(open) {
    el.card.classList.toggle('is-expanded', open);
    el.sheetToggle.setAttribute('aria-expanded', String(open));
    el.sheetLabel.textContent = open ? 'Hide details' : 'Show details';
    if (!open) el.cardScroll.scrollTop = 0;
  }

  /* ------------------------------------------------------------- input */

  function bindInput() {
    // Wheel = travel. Ctrl+wheel (and trackpad pinch, which reports ctrlKey)
    // falls through to OrbitControls for zoom. Scrolling inside the card scrolls the card.
    let acc = 0;
    let lockUntil = 0;
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      const scroller = e.target.closest?.('[data-scrollable]');
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 2) return;
      if (e.target.closest?.('#drawer')) return;
      e.preventDefault();
      e.stopPropagation(); // keep OrbitControls from zooming on plain scroll
      const now = performance.now();
      if (now < lockUntil) return;
      acc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(acc) > 60) {
        acc > 0 ? handlers.next() : handlers.prev();
        acc = 0;
        lockUntil = now + 900;
      }
    }, { passive: false, capture: true });

    window.addEventListener('keydown', (e) => {
      if (e.target.matches?.('input, textarea')) return;
      if (e.key === 'Escape') { closeDrawer(); setSheet(false); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); handlers.next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); handlers.prev(); }
      else if (/^[1-7]$/.test(e.key)) handlers.select(Number(e.key) - 1);
    });

    // Horizontal swipe on the headline or the sheet handle travels (the canvas keeps drag-to-rotate).
    for (const zone of [el.headline, el.sheetToggle]) {
      let x0 = null, y0 = null;
      zone.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      zone.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) dx < 0 ? handlers.next() : handlers.prev();
        else if (zone === el.sheetToggle && Math.abs(dy) > 40) setSheet(dy < 0);
        x0 = y0 = null;
      }, { passive: true });
    }
  }

  /**
   * Screen area covered by UI, so main.js can centre the model in what's left
   * (via camera.setViewOffset) instead of hiding it behind the card.
   */
  function layoutInsets() {
    const w = innerWidth, h = innerHeight;
    if (w >= 1024) {
      const r = el.card.getBoundingClientRect();
      const headH = el.headline.getBoundingClientRect().height;
      return { left: 0, right: Math.max(0, w - r.left), top: 90, bottom: Math.min(h * 0.42, 175 + headH * 0.55) };
    }
    const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek')) || 150;
    const headH = el.headline.getBoundingClientRect().height;
    return { left: 0, right: 0, top: 64, bottom: Math.min(h * 0.5, peek + headH + 20) };
  }

  return {
    init, setThumbnails, setLoading, hideLoader, showNo3D,
    leave, enter, travel, setActive, layoutInsets, closeDrawer,
  };
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
