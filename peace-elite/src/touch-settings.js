// Shared touch-mode and sensitivity settings; no browser globals needed at import time.
export const TOUCH_DEFAULTS = Object.freeze({ look: 100, ads: 60 });
const STORE = 'peace_elite_touch_settings_v1';
export function touchEnabled(env = globalThis) {
  return !!(env.matchMedia?.('(pointer: coarse)').matches || env.navigator?.maxTouchPoints > 0 ||
    new URLSearchParams(env.location?.search || '').has('touch'));
}
export function normalizeTouchSettings(value) {
  const result = { ...TOUCH_DEFAULTS };
  for (const key of Object.keys(result)) {
    if (typeof value?.[key] === 'number' && Number.isFinite(value[key])) {
      result[key] = Math.round(Math.max(20, Math.min(180, value[key])));
    }
  }
  return result;
}
export function loadTouchSettings() {
  try { return normalizeTouchSettings(JSON.parse(globalThis.localStorage?.getItem(STORE) || 'null')); }
  catch { return { ...TOUCH_DEFAULTS }; }
}
export function saveTouchSettings(value) {
  const settings = normalizeTouchSettings(value);
  try { globalThis.localStorage?.setItem(STORE, JSON.stringify(settings)); } catch { /* Session settings remain usable. */ }
  return settings;
}
// Same fraction of the landscape viewport produces the same angle on phones/tablets.
// A full-width hip-fire swipe turns 240 degrees; ADS has a separate, finer multiplier.
export function touchLookRadians(pixels, width, sensitivity, scopeScale = 1) {
  return pixels / Math.max(320, width) * (Math.PI * 4 / 3) * sensitivity / 100 * scopeScale;
}
