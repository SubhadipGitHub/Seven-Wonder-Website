/**
 * ui.js
 * ---------------------------------------------------------------------------
 * DOM side of the atlas: builds the thumbnail rail and mobile drawer, fills
 * the tabbed information card, animates the headline, the travelling
 * coordinates and the mini globe, and turns input (wheel, keys, swipes) into
 * navigation intents.
 *
 * It never touches Three.js. MorphController calls leave()/travel()/enter()
 * at the right moments of each transition; main.js wires the intents.
 * ---------------------------------------------------------------------------
 */
import gsap from 'gsap';
import { createGlobe } from './globe.js';
import { createQuiz } from './quiz.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TABS = ['overview', 'timeline', 'facts', 'visit'];

export function createUI({ reducedMotion = false } = {}) {
  const el = {
    loader: $('#loader'),
    loaderFill: $('#loader-fill'),
    loaderStatus: $('#loader-status'),
    loaderFact: $('#loader-fact'),
    name: $('#wonder-name'),
    badge: $('#wonder-badge'),
    lat: $('#coord-lat'),
    lng: $('#coord-lng'),
    place: $('#wonder-place'),
    distance: $('#wonder-distance'),
    timeChip: $('#wonder-time'),
    timeText: $('#wonder-time-text'),
    counterNow: $('#counter-now'),
    counterOf: $('#counter-of'),
    card: $('#card'),
    cardInner: $('#card-inner'),
    cardScroll: $('#card-scroll'),
    tablist: $('[role="tablist"]'),
    built: $('#f-built'),
    by: $('#f-by'),
    unesco: $('#f-unesco'),
    unescoNote: $('#f-unesco-note'),
    stats: $('#f-stats'),
    context: $('#f-context'),
    highlights: $('#f-highlights'),
    materialsWrap: $('#f-materials-wrap'),
    materials: $('#f-materials'),
    timeline: $('#f-timeline'),
    fact: $('#fact'),
    factKind: $('#fact-kind'),
    factText: $('#f-fact'),
    factTruth: $('#fact-truth'),
    factCount: $('#fact-count'),
    factBtn: $('#btn-fact'),
    visit: $('#f-visit'),
    visitNote: $('#f-visit-note'),
    sources: $('#f-sources'),
    shareBtn: $('#btn-share'),
    shareNote: $('#share-note'),
    arBtn: $('#btn-ar'),
    arNote: $('#ar-note'),
    railList: $('#rail-list'),
    drawer: $('#drawer'),
    drawerList: $('#drawer-list'),
    menuBtn: $('#menu-btn'),
    tourBtn: $('#btn-tour'),
    soundBtn: $('#btn-sound'),
    helpBtn: $('#btn-help'),
    help: $('#help'),
    helpMax: $('#help-max'),
    quiz: $('#quiz'),
    quizBtn: $('#btn-quiz'),
    sheetToggle: $('#sheet-toggle'),
    sheetLabel: $('#sheet-label'),
    status: $('#sr-status'),
    headline: $('#headline'),
    globe: $('#globe'),
    no3d: $('#no3d'),
  };

  let wonders = [];
  let handlers = { select() {}, next() {}, prev() {}, tour() {}, sound() {}, time() {} };
  let currentData = null;
  let previousData = null;
  let tab = 'overview';
  let factIndex = 0;
  let globe = null;
  let shareTimer = 0;
  let quiz = null;
  let units = initialUnits();
  const coordState = { lat: 0, lng: 0, t: 1 };

  /* ------------------------------------------------------------ building */

  function init(list, h) {
    wonders = list;
    handlers = { ...handlers, ...h };
    const thumbVars = (w) => `--t-top:${w.theme.skyTop};--t-bottom:${w.theme.skyBottom}`;
    const tag = (w) => (w.honorary ? '<span class="thumb-tag">Honorary</span>' : '');

    el.railList.innerHTML = list.map((w, i) => `
      <li${w.honorary ? ' class="is-honorary"' : ''}><button class="thumb" data-index="${i}" aria-label="${escapeHTML(w.name)}, ${escapeHTML(w.country)}${w.honorary ? ' (honorary)' : ''}">
        <span class="thumb-img" style="${thumbVars(w)}"></span>
        <span>${escapeHTML(w.name)}${tag(w)}</span>
      </button></li>`).join('');

    el.drawerList.innerHTML = list.map((w, i) => `
      <li><button class="drawer-item" data-index="${i}">
        <span class="thumb-img" style="${thumbVars(w)}"></span>
        <span><strong>${escapeHTML(w.name)}</strong><span class="sub">${escapeHTML(w.country)}${w.honorary ? ' · honorary' : ''}</span></span>
      </button></li>`).join('');

    $$('[data-index]').forEach((b) =>
      b.addEventListener('click', () => {
        handlers.select(Number(b.dataset.index));
        closeDrawer();
      })
    );
    $$('[data-next]').forEach((b) => b.addEventListener('click', () => handlers.next()));
    $$('[data-prev]').forEach((b) => b.addEventListener('click', () => handlers.prev()));

    el.factBtn.addEventListener('click', () => showFact(factIndex + 1, true));
    el.arBtn.addEventListener('click', openAR);
    el.shareBtn.addEventListener('click', share);
    el.menuBtn.addEventListener('click', openDrawer);
    el.tourBtn.addEventListener('click', () => handlers.tour());
    el.soundBtn.addEventListener('click', () => handlers.sound());
    el.helpBtn.addEventListener('click', openHelp);
    $$('[data-help-close]', el.help).forEach((b) => b.addEventListener('click', () => el.help.close()));
    el.help.addEventListener('click', (e) => { if (e.target === el.help) el.help.close(); }); // backdrop
    $$('[data-close]', el.drawer).forEach((b) => b.addEventListener('click', closeDrawer));
    el.sheetToggle.addEventListener('click', () => setSheet(!el.card.classList.contains('is-expanded')));

    el.timeChip.addEventListener('click', () => handlers.time());
    el.distance.addEventListener('click', toggleUnits);
    quiz = createQuiz(el.quiz, { wonders: list, onGo: (i) => handlers.select(i) });
    el.quizBtn.addEventListener('click', () => { closeDrawer(); quiz.start(); });

    el.helpMax.textContent = String(Math.min(9, list.length));
    if (el.globe.getContext) globe = createGlobe(el.globe, { points: list.map((w) => w.coordinates) });

    bindTabs();
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

  /** A random plain fact (not a myth) under the loader bar while models build. */
  function showLoaderFact(list) {
    const pool = list.flatMap((w) => factsOf(w).filter((f) => f.type !== 'myth').map((f) => ({ w, f })));
    if (!pool.length) return;
    const { w, f } = pool[Math.floor(Math.random() * pool.length)];
    el.loaderFact.textContent = `${w.name}: ${f.text}`;
    if (!reducedMotion) gsap.fromTo(el.loaderFact, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.8, delay: 0.3 });
  }

  /* --------------------------------------------------- transition phases */

  /** Old content exits in the direction of travel. */
  function leave(dir = 1) {
    if (reducedMotion) return gsap.to([el.cardInner, el.name], { opacity: 0, duration: 0.2 });
    const chars = $$('.char', el.name);
    gsap.to(chars, { yPercent: -110, duration: 0.45, ease: 'power3.in', stagger: { each: 0.012, from: dir > 0 ? 'start' : 'end' } });
    gsap.to([el.place, el.distance, el.badge], { opacity: 0, duration: 0.3 });
    gsap.to(el.cardInner, { opacity: 0, x: -24 * dir, duration: 0.4, ease: 'power2.in' });
  }

  /** New content enters. */
  function enter(data, index, dir = 1) {
    previousData = currentData;
    currentData = data;
    fillCard(data);
    setName(data.name);
    el.badge.hidden = !data.honorary;
    el.place.textContent = `${data.region}, ${data.country}`;
    setDistance();
    setCounter(index);
    el.status.textContent = `Now showing ${data.name}, ${data.country}${data.honorary ? ' (honorary wonder)' : ''}.`;
    setActive(index);
    el.cardScroll.scrollTop = 0;

    if (reducedMotion) {
      gsap.set([el.cardInner, el.name, el.place, el.distance, el.badge], { opacity: 1, x: 0 });
      return;
    }
    gsap.set(el.name, { opacity: 1 });
    gsap.fromTo($$('.char', el.name), { yPercent: 110 }, {
      yPercent: 0, duration: 0.9, ease: 'power4.out', stagger: { each: 0.018, from: dir > 0 ? 'start' : 'end' },
    });
    gsap.fromTo([el.place, el.distance, el.badge], { opacity: 0 }, { opacity: 1, duration: 0.6, delay: 0.35 });
    gsap.fromTo(el.cardInner, { opacity: 0, x: 28 * dir }, { opacity: 1, x: 0, duration: 0.7, ease: 'power3.out' });
    revealPanel(0.25);
  }

  function setCounter(index) {
    // The seven are numbered; the honorary wonder isn't one of them.
    const seven = wonders.filter((w) => !w.honorary).length;
    const data = wonders[index];
    if (data?.honorary) {
      el.counterNow.textContent = 'Honorary';
      el.counterOf.textContent = '';
    } else {
      el.counterNow.textContent = String(wonders.slice(0, index + 1).filter((w) => !w.honorary).length);
      el.counterOf.textContent = ` of ${seven}`;
    }
  }

  /** Coordinates count from the old location to the new one; the globe follows the great circle. */
  function travel(fromData, toData, duration = 2) {
    const from = fromData ? fromData.coordinates : { lat: 0, lng: 0 };
    const index = wonders.indexOf(toData);
    gsap.killTweensOf(coordState);
    if (!fromData) Object.assign(coordState, from);
    coordState.t = 0;
    const start = { lat: coordState.lat, lng: coordState.lng };
    gsap.to(coordState, {
      lat: toData.coordinates.lat,
      lng: toData.coordinates.lng,
      t: 1,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => {
        renderCoords();
        if (fromData) globe?.travel(start, toData.coordinates, coordState.t, index);
      },
      onComplete: () => { if (!fromData) globe?.show(toData.coordinates, index); },
    });
    if (!fromData) globe?.show(toData.coordinates, index);
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

  function setDistance() {
    const from = previousData;
    el.distance.hidden = !from;
    if (from) {
      el.distance.textContent = `${fmtDistance(haversineKm(from.coordinates, currentData.coordinates), units)} from ${from.name}`;
      el.distance.setAttribute('aria-label', `${el.distance.textContent}. Switch to ${units === 'km' ? 'miles' : 'kilometres'}`);
    }
  }

  /* --------------------------------------------------------------- card */

  function fillCard(d) {
    // Overview
    el.built.textContent = d.built;
    el.by.textContent = d.builtBy;
    el.unesco.textContent = String(d.unesco);
    el.unescoNote.hidden = !d.unescoNote;
    el.unescoNote.textContent = d.unescoNote || '';
    const stats = d.keyStats?.length ? d.keyStats : d.stat ? [d.stat] : [];
    el.stats.innerHTML = stats.map((s) => `
      <li><span class="stat-value">${escapeHTML(s.value)}</span><span class="stat-label">${escapeHTML(s.label)}</span></li>`).join('');
    el.context.textContent = d.context;
    el.highlights.innerHTML = d.highlights.map((h) => `<li>${escapeHTML(h)}</li>`).join('');
    el.materialsWrap.hidden = !d.materials?.length;
    el.materials.innerHTML = (d.materials || []).map((m) => `<li>${escapeHTML(m)}</li>`).join('');

    // Timeline
    setTabAvailable('timeline', !!d.timeline?.length);
    el.timeline.innerHTML = (d.timeline || []).map((t) => `
      <li><span class="tl-year">${escapeHTML(t.year)}</span><span class="tl-event">${escapeHTML(t.event)}</span></li>`).join('');

    // Facts
    factIndex = 0;
    showFact(0, false);

    renderVisit(d);

    // Actions: AR only when there's a model file to place.
    const m = d.model || {};
    el.arBtn.hidden = !(m.glb || m.usdz);
    el.arNote.hidden = true;
    el.shareNote.hidden = true;
  }

  function renderVisit(d) {
    const v = d.visit || {};
    const rows = [];
    if (v.nearestCity) rows.push(['Getting there', v.nearestCity]);
    if (v.bestTime) rows.push(['Best time', v.bestTime]);
    if (v.visitors) rows.push(['Visitors', `${v.visitors.value}${v.visitors.year ? ` (${v.visitors.year})` : ''}`]);
    if (previousData) rows.push([`From ${previousData.name}`, `${fmtDistance(haversineKm(previousData.coordinates, d.coordinates), units)} as the crow flies`]);
    el.visit.innerHTML = rows.map(([k, val]) => `<div><dt>${escapeHTML(k)}</dt><dd>${escapeHTML(val)}</dd></div>`).join('');
    el.visitNote.hidden = !v.note;
    el.visitNote.textContent = v.note || '';
    el.sources.innerHTML = (d.sources || []).map((s) =>
      `<li><a href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.label)}</a></li>`).join('');
    setTabAvailable('visit', rows.length > 0 || !!d.sources?.length);
    if ($(`#tab-${tab}`).hidden) selectTab('overview', { focus: false, animate: false });
  }

  /* --------------------------------------------------- units & clock */

  function toggleUnits() {
    units = units === 'km' ? 'mi' : 'km';
    try { localStorage.setItem('atlas:units', units); } catch { /* private mode */ }
    setDistance();
    if (currentData) renderVisit(currentData);
  }

  /** Local time and light at the wonder; `mode` is 'live' or a preview preset. */
  function setTime({ local, phase, mode }) {
    const live = mode === 'live';
    el.timeChip.dataset.phase = phase.key;
    el.timeChip.classList.toggle('is-preview', !live);
    el.timeText.textContent = live
      ? `${local.text} ${local.solar ? 'solar time' : 'local time'} · ${phase.label}`
      : `Preview · ${phase.label}`;
    const next = { live: 'sunrise', sunrise: 'midday', midday: 'sunset', sunset: 'night', night: 'the live sky' }[mode];
    el.timeChip.title = live
      ? 'The sky and light follow the real sun at this wonder. Click to preview other times of day.'
      : `Click for ${next}.`;
    el.timeChip.setAttribute('aria-label', live
      ? `${phase.label} at this wonder, ${local.text} local time. Change the time of day`
      : `Previewing ${phase.label.toLowerCase()}. Change the time of day`);
  }

  function setTabAvailable(name, ok) {
    $(`#tab-${name}`).hidden = !ok;
  }

  /* -------------------------------------------------------------- facts */

  /** Facts list with fallback to the old single funFact field. */
  function factsOf(d) {
    if (d.facts?.length) return d.facts;
    return d.funFact ? [{ type: 'fact', text: d.funFact }] : [];
  }

  function showFact(i, animate) {
    const list = factsOf(currentData);
    setTabAvailable('facts', list.length > 0);
    if (!list.length) return;
    factIndex = ((i % list.length) + list.length) % list.length;
    const f = list[factIndex];
    const apply = () => {
      const myth = f.type === 'myth';
      el.fact.classList.toggle('is-myth', myth);
      el.factKind.textContent = myth ? 'Myth' : 'Did you know?';
      el.factText.textContent = f.text;
      el.factTruth.hidden = !(myth && f.truth);
      el.factTruth.innerHTML = myth && f.truth ? `<strong>Actually:</strong> ${escapeHTML(f.truth)}` : '';
      el.factCount.textContent = `${factIndex + 1} of ${list.length}`;
    };
    el.factBtn.hidden = list.length < 2;
    if (!animate || reducedMotion) return apply();
    gsap.to(el.fact, {
      opacity: 0, y: -6, duration: 0.18, ease: 'power1.in',
      onComplete: () => { apply(); gsap.fromTo(el.fact, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }); },
    });
  }

  /* --------------------------------------------------------------- tabs */

  function bindTabs() {
    $$('[role="tab"]', el.tablist).forEach((b) => b.addEventListener('click', () => {
      selectTab(b.dataset.tab, { focus: false });
      if (!isDesktop() && !el.card.classList.contains('is-expanded')) setSheet(true);
    }));
    el.tablist.addEventListener('keydown', (e) => {
      const visible = TABS.filter((t) => !$(`#tab-${t}`).hidden);
      const i = visible.indexOf(tab);
      let next = null;
      if (e.key === 'ArrowRight') next = visible[(i + 1) % visible.length];
      else if (e.key === 'ArrowLeft') next = visible[(i - 1 + visible.length) % visible.length];
      else if (e.key === 'Home') next = visible[0];
      else if (e.key === 'End') next = visible[visible.length - 1];
      if (!next) return;
      e.preventDefault();
      e.stopPropagation(); // arrows here switch tabs, not wonders
      selectTab(next, { focus: true });
    });
  }

  function selectTab(name, { focus = false, animate = true } = {}) {
    tab = name;
    for (const t of TABS) {
      const b = $(`#tab-${t}`), p = $(`#panel-${t}`), on = t === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    }
    if (focus) $(`#tab-${name}`).focus();
    el.cardScroll.scrollTop = 0;
    if (animate) revealPanel(0);
  }

  function revealPanel(delay) {
    if (reducedMotion) return;
    const items = $$(`#panel-${tab} :is(.facts > div, .stats li, .highlights li, .timeline li, .fact-card, .tags, .sources li, .context)`);
    gsap.fromTo(items, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.045, delay, ease: 'power2.out', overwrite: true });
  }

  function setActive(index) {
    $$('[data-index]').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.index) === index)));
  }

  /* ------------------------------------------------------ share & AR */

  async function share() {
    const d = currentData;
    const url = location.href;
    const text = `${d.name}, ${d.country} — in the New Seven Wonders atlas.`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: d.name, text, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    let msg = 'Link copied to the clipboard.';
    try { await navigator.clipboard.writeText(url); }
    catch { msg = `Copy this link: ${url}`; }
    el.shareNote.textContent = msg;
    el.shareNote.hidden = false;
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => { el.shareNote.hidden = true; }, 4000);
  }

  /**
   * "View in AR" (only shown when the wonder has a model file):
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
    if (isIOS && !m.usdz) msg = 'On iPhone and iPad, AR needs a .usdz version of this model.';
    else msg = 'Open this page on an AR-capable phone or tablet to place the model in your room.';
    el.arNote.textContent = msg;
    el.arNote.hidden = false;
  }

  /* ------------------------------------------------ topbar toggles */

  function setTour(on) {
    el.tourBtn.setAttribute('aria-pressed', String(on));
    el.tourBtn.setAttribute('aria-label', on ? 'Pause the guided tour' : 'Start the guided tour');
    el.status.textContent = on ? 'Guided tour started.' : 'Guided tour paused.';
  }
  function setSound(on) {
    el.soundBtn.setAttribute('aria-pressed', String(on));
    el.soundBtn.setAttribute('aria-label', on ? 'Turn ambient sound off' : 'Turn ambient sound on');
  }
  function openHelp() {
    if (el.help.open) return el.help.close();
    closeDrawer();
    el.help.showModal();
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
  const isDesktop = () => innerWidth >= 1024;

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
      if (e.target.closest?.('#drawer, #help, #quiz')) return;
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
      if (e.target.matches?.('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el.help.open || el.quiz.open) return; // dialogs handle their own keys
      if (e.target.closest?.('[role="tablist"]') && /^Arrow|^Home$|^End$/.test(e.key)) return;
      if (e.key === 'Escape') { closeDrawer(); setSheet(false); return; }
      if (e.key === '?') { e.preventDefault(); openHelp(); return; }
      const k = e.key.toLowerCase();
      if (k === 't') return handlers.tour();
      if (k === 'm') return handlers.sound();
      if (k === 'q') return quiz.start();
      if (k === 'l') return handlers.time();
      if (k === 'f') { if (tab !== 'facts') selectTab('facts'); else showFact(factIndex + 1, true); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); handlers.next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); handlers.prev(); }
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= wonders.length) handlers.select(Number(e.key) - 1);
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
    init, setThumbnails, setLoading, hideLoader, showNo3D, showLoaderFact,
    leave, enter, travel, setActive, layoutInsets, closeDrawer,
    setTour, setSound, setTime,
  };
}

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function fmtDistance(km, units) {
  const v = units === 'mi' ? km / 1.609344 : km;
  return `${Math.round(v).toLocaleString('en-GB')} ${units === 'mi' ? 'miles' : 'km'}`;
}

/** Remembered choice, else miles where they're the everyday unit. */
function initialUnits() {
  try { const u = localStorage.getItem('atlas:units'); if (u === 'km' || u === 'mi') return u; } catch { /* ignore */ }
  return /^en-(US|GB|LR)$|^my\b/.test(navigator.language || '') ? 'mi' : 'km';
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
