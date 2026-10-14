/**
 * sky.js
 * ---------------------------------------------------------------------------
 * Time of day at each wonder. Works out where the sun really is right now
 * (or at a preview time), then blends the wonder's own palette towards day,
 * golden hour, blue hour or night, and describes the light that goes with it.
 *
 * Pure functions, no DOM or Three.js: main.js turns the result into CSS
 * variables and light tweens, ui.js into the local-time label.
 *
 * Solar position uses the standard low-precision formulas (mean anomaly →
 * ecliptic longitude → declination / right ascension → hour angle), good to
 * well under a degree, which is all a sky colour needs.
 * ---------------------------------------------------------------------------
 */
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

/**
 * Sun position for a date and place.
 * @returns {{ altitude: number, azimuth: number }} degrees; azimuth is a
 *          compass bearing (0 = north, 90 = east).
 */
export function sunPosition(date, lat, lng) {
  const d = date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lng - ra;
  const phi = RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)); // from south, westward
  return { altitude: altitude / RAD, azimuth: ((azimuth / RAD + 180) % 360 + 360) % 360 };
}

/** Fixed looks for previewing; `null` = live. */
export const PREVIEWS = {
  live: null,
  sunrise: { altitude: 1.5, azimuth: 92, rising: true, label: 'Sunrise' },
  midday: { altitude: 62, azimuth: 180, rising: false, label: 'Midday' },
  sunset: { altitude: 1.5, azimuth: 268, rising: false, label: 'Sunset' },
  night: { altitude: -32, azimuth: 0, rising: false, label: 'Night' },
};
export const PREVIEW_ORDER = Object.keys(PREVIEWS);

/** The sun at a wonder, either live or from a preview preset. */
export function sunAt(wonder, mode = 'live', now = new Date()) {
  const p = PREVIEWS[mode];
  if (p) return { ...p };
  const { lat, lng } = wonder.coordinates;
  const s = sunPosition(now, lat, lng);
  const later = sunPosition(new Date(now.valueOf() + 10 * 60000), lat, lng);
  return { ...s, rising: later.altitude > s.altitude };
}

/** Words for the light, from altitude and direction of travel. */
export function phaseOf({ altitude: a, rising }) {
  if (a >= 16) return { key: 'day', label: 'Daylight' };
  if (a >= 2) return { key: 'golden', label: 'Golden hour' };
  if (a >= -4) return { key: rising ? 'sunrise' : 'sunset', label: rising ? 'Sunrise' : 'Sunset' };
  if (a >= -12) return { key: 'twilight', label: rising ? 'Dawn' : 'Dusk' };
  return { key: 'night', label: 'Night' };
}

/**
 * Everything the scene needs for this sun over this wonder's palette.
 * Colours are hex strings; intensities are three.js light units.
 */
export function skyState(theme, sun) {
  const a = sun.altitude;
  const day = smoothstep(-8, 8, a);                                   // 0 night → 1 day
  const high = smoothstep(15, 55, a);                                 // midday brightness
  const golden = smoothstep(-4, 2, a) * (1 - smoothstep(3, 18, a));   // low warm sun
  const blue = smoothstep(-13, -6, a) * (1 - smoothstep(-3, 1, a));   // blue hour
  const stars = 1 - smoothstep(-13, -3, a);

  let top = mix(mix(theme.skyTop, '#04060d', 0.55), mix(theme.skyTop, '#2c5a88', 0.3 + 0.25 * high), day);
  top = mix(top, '#1b2152', 0.4 * blue);
  let bottom = mix(mix(theme.skyBottom, '#0c1121', 0.6), mix(theme.skyBottom, '#97afbf', 0.18 + 0.3 * high), day);
  bottom = mix(bottom, '#de874d', 0.62 * golden);
  bottom = mix(bottom, '#4a4787', 0.38 * blue);

  // Light: the sun by day, a cool high moon-ish fill by night.
  const sunlit = day >= 0.5;
  const el = sunlit ? Math.max(a, 10) : 52;
  const az = sunlit ? sun.azimuth : (sun.azimuth + 180) % 360;
  return {
    skyTop: top,
    skyBottom: bottom,
    stars,
    key: mix('#a8b6ff', mix(theme.key, '#ffad72', golden), day),
    keyIntensity: lerp(0.55, lerp(2.9, 1.9, golden), day),
    keyDir: direction(el, az),
    hemiSky: mix('#55639a', '#c9d6ff', day),
    hemiIntensity: lerp(0.22, 0.58, day),
    rimIntensity: lerp(0.55, 1.1, day),
    envIntensity: lerp(0.2, 0.58, day),
    day,
  };
}

/**
 * Unit vector towards the light in scene space. Scene "north" is −Z, so the
 * light swings round the model through the day like the real sun.
 */
function direction(elevationDeg, azimuthDeg) {
  const e = elevationDeg * RAD, z = azimuthDeg * RAD;
  return { x: Math.cos(e) * Math.sin(z), y: Math.sin(e), z: -Math.cos(e) * Math.cos(z) };
}

/** Local wall-clock time at the wonder; falls back to solar time from longitude. */
export function localTime(wonder, now = new Date()) {
  try {
    return {
      text: new Intl.DateTimeFormat('en-GB', { timeZone: wonder.timeZone, hour: '2-digit', minute: '2-digit' }).format(now),
      solar: false,
    };
  } catch {
    const mins = ((now.getUTCHours() * 60 + now.getUTCMinutes() + Math.round(wonder.coordinates.lng * 4)) % 1440 + 1440) % 1440;
    return { text: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, solar: true };
  }
}

/* ------------------------------------------------------------- helpers */

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }

function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
