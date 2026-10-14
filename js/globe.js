/**
 * globe.js
 * ---------------------------------------------------------------------------
 * A small orthographic globe on a 2D canvas: land, graticule, a dot for every
 * wonder, and a great-circle arc that draws itself as the atlas travels.
 *
 * No map library: the projection is a dozen lines, and the land comes from
 * data/land-110m.json (Natural Earth 110m, rounded to 0.1°). ui.js drives it
 * from the same tween that counts the coordinates, so the two stay in step.
 * ---------------------------------------------------------------------------
 */
const RAD = Math.PI / 180;

/** Unit vector for a lat/lng in degrees. */
function vec(lat, lng) {
  const p = lat * RAD, l = lng * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}
function toLatLng([x, y, z]) {
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lng: Math.atan2(y, x) / RAD };
}
/** Spherical interpolation between two lat/lngs, t ∈ [0, 1]. */
export function slerp(a, b, t) {
  const A = vec(a.lat, a.lng), B = vec(b.lat, b.lng);
  const d = Math.acos(Math.min(1, Math.max(-1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
  if (d < 1e-6) return { ...b };
  const s = Math.sin(d), ka = Math.sin((1 - t) * d) / s, kb = Math.sin(t * d) / s;
  return toLatLng([A[0] * ka + B[0] * kb, A[1] * ka + B[1] * kb, A[2] * ka + B[2] * kb]);
}

export function createGlobe(canvas, { points = [] } = {}) {
  const ctx = canvas.getContext('2d');
  let rings = [];
  let center = { lat: 20, lng: 0 };
  let arc = null;          // { from, to, t }
  let current = -1;
  let size = 0, dpr = 1;
  let raf = 0;

  fetch('./data/land-110m.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) { rings = d.rings; draw(); } })
    .catch(() => { /* the globe still works as a graticule without land */ });

  function resize() {
    const css = canvas.clientWidth;
    if (!css) return false;
    dpr = Math.min(devicePixelRatio || 1, 2);
    if (css !== size || canvas.width !== Math.round(css * dpr)) {
      size = css;
      canvas.width = canvas.height = Math.round(css * dpr);
    }
    return true;
  }

  /** Project to canvas space; `v` is false on the far side. */
  function project(lat, lng, R, cx, cy, cl) {
    const p = lat * RAD, dl = (lng - center.lng) * RAD;
    const cosp = Math.cos(p);
    const x = cosp * Math.sin(dl);
    const y = cl.cos0 * Math.sin(p) - cl.sin0 * cosp * Math.cos(dl);
    const v = cl.sin0 * Math.sin(p) + cl.cos0 * cosp * Math.cos(dl) >= 0;
    return { x: cx + x * R, y: cy - y * R, v, nx: x, ny: y };
  }

  function draw() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }

  function render() {
    if (!resize()) return;
    const W = canvas.width, R = W / 2 - 2 * dpr, cx = W / 2, cy = W / 2;
    const css = getComputedStyle(canvas);
    const accent = css.getPropertyValue('--accent').trim() || '#d2b77c';
    const cl = { sin0: Math.sin(center.lat * RAD), cos0: Math.cos(center.lat * RAD) };
    ctx.clearRect(0, 0, W, W);

    // ocean
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, 'rgba(239,231,214,0.10)');
    g.addColorStop(1, 'rgba(239,231,214,0.02)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // graticule, every 30°
    ctx.strokeStyle = 'rgba(239,231,214,0.10)';
    ctx.lineWidth = dpr * 0.6;
    ctx.beginPath();
    for (let lng = -180; lng < 180; lng += 30) polyline(Array.from({ length: 37 }, (_, i) => [-90 + i * 5, lng]), R, cx, cy, cl);
    for (let lat = -60; lat <= 60; lat += 30) polyline(Array.from({ length: 73 }, (_, i) => [lat, -180 + i * 5]), R, cx, cy, cl);
    ctx.stroke();

    // land: points behind the horizon are pushed onto the rim, which keeps fills closed
    ctx.fillStyle = 'rgba(239,231,214,0.26)';
    ctx.beginPath();
    for (const r of rings) {
      let any = false;
      const pts = [];
      for (let i = 0; i < r.length; i += 2) {
        const q = project(r[i + 1], r[i], R, cx, cy, cl);
        if (q.v) any = true;
        else { const n = Math.hypot(q.nx, q.ny) || 1; q.x = cx + (q.nx / n) * R; q.y = cy - (q.ny / n) * R; }
        pts.push(q);
      }
      if (!any) continue;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    ctx.fill();

    // rim
    ctx.strokeStyle = 'rgba(239,231,214,0.28)';
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

    // travel arc
    if (arc) {
      const steps = 48, n = Math.max(1, Math.round(steps * arc.t));
      const pts = Array.from({ length: n + 1 }, (_, i) => {
        const p = slerp(arc.from, arc.to, (i / n) * arc.t);
        return [p.lat, p.lng];
      });
      ctx.strokeStyle = accent;
      ctx.globalAlpha = arc.t < 1 ? 0.95 : 0.55;
      ctx.lineWidth = dpr * 1.4;
      ctx.setLineDash([3 * dpr, 2.5 * dpr]);
      ctx.beginPath(); polyline(pts, R, cx, cy, cl); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // wonders
    points.forEach((p, i) => {
      const q = project(p.lat, p.lng, R, cx, cy, cl);
      if (!q.v) return;
      const on = i === current;
      if (on) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(q.x, q.y, 6 * dpr, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = on ? accent : 'rgba(239,231,214,0.75)';
      ctx.beginPath(); ctx.arc(q.x, q.y, (on ? 2.6 : 1.6) * dpr, 0, Math.PI * 2); ctx.fill();
    });
  }

  function polyline(latlngs, R, cx, cy, cl) {
    let pen = false;
    for (const [lat, lng] of latlngs) {
      const q = project(lat, lng, R, cx, cy, cl);
      if (!q.v) { pen = false; continue; }
      pen ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      pen = true;
    }
  }

  addEventListener('resize', draw);

  return {
    /** Rotate to a point (no arc). */
    show(at, index) { center = { lat: at.lat, lng: at.lng }; current = index; draw(); },
    /** During travel: centre follows the great circle, the arc draws to `t`. */
    travel(from, to, t, index) {
      arc = { from, to, t };
      center = slerp(from, to, t);
      current = t >= 1 ? index : -1;
      draw();
    },
    redraw: draw,
  };
}
