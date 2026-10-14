/**
 * tour.js
 * ---------------------------------------------------------------------------
 * Guided tour: advances to the next wonder a fixed time after each arrival.
 * main.js stops it on any user navigation or orbit; it also holds while the
 * tab is hidden, so it never races ahead in the background.
 * ---------------------------------------------------------------------------
 */
export function createTour({ advance, onState, dwell = 9000 }) {
  let on = false;
  let timer = 0;
  const clear = () => { clearTimeout(timer); timer = 0; };
  const schedule = () => {
    clear();
    if (on && !document.hidden) timer = setTimeout(advance, dwell);
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? clear() : schedule()));

  return {
    get on() { return on; },
    start() { if (on) return; on = true; onState(true); advance(); },
    stop() { if (!on) return; on = false; clear(); onState(false); },
    toggle() { on ? this.stop() : this.start(); },
    /** Call when a transition finishes. */
    arrived: schedule,
  };
}
