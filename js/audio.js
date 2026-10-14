/**
 * audio.js
 * ---------------------------------------------------------------------------
 * Optional ambience, synthesised with WebAudio so there are no files to load:
 * a soft wind bed (looped noise through a band-pass whose centre drifts on a
 * slow LFO) and a swell under each vortex transition.
 *
 * Off by default. Browsers only allow audio after a user gesture, so the
 * AudioContext is created the first time sound is switched on; a remembered
 * "on" preference waits for the first click or key press.
 * ---------------------------------------------------------------------------
 */
const KEY = 'atlas:sound';
const BED = 0.05;

export function createAmbience() {
  let ctx = null, master = null, bed = null, filter = null;
  let on = false;

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown-ish noise: integrated white noise sounds like wind, not hiss.
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.7;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(filter.frequency);

    bed = ctx.createGain();
    bed.gain.value = BED;
    master = ctx.createGain();
    master.gain.value = 0;

    src.connect(filter).connect(bed).connect(master).connect(ctx.destination);
    src.start();
    lfo.start();
  }

  function ramp(param, value, seconds) {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

  function set(next) {
    on = next;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
    if (on) {
      if (!ctx) build();
      ctx.resume();
      ramp(master.gain, 1, 1.2);
    } else if (ctx) {
      ramp(master.gain, 0, 0.5);
      setTimeout(() => { if (!on) ctx.suspend(); }, 600);
    }
  }

  /** Rise under the vortex, then settle. */
  function swell(duration = 2.6) {
    if (!on || !ctx) return;
    const t = ctx.currentTime;
    for (const [param, peak, rest] of [[bed.gain, BED * 3.2, BED], [filter.frequency, 1100, 420]]) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(peak, t + duration * 0.4);
      param.linearRampToValueAtTime(rest, t + duration);
    }
  }

  let remembered = false;
  try { remembered = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }

  return {
    get on() { return on; },
    get remembered() { return remembered; },
    toggle() { set(!on); return on; },
    set,
    swell,
  };
}
