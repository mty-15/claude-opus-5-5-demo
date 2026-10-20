import { heightAt, LOCATIONS, MAP_SIZE } from './terrain.js';

const MAP_MIN = -MAP_SIZE / 2;
const TERRAIN_RESOLUTION = 256;
const MAP_REFRESH_MS = 100;
const COMPASS_SCALE = 2.4;
const GOLD = '#e6bd60';
const WEAPON_NAMES = Object.freeze({ m416: 'M416', akm: 'AKM', ump45: 'UMP45', kar98: 'Kar98K' });
const FIRE_MODES = Object.freeze({ auto: '全自动', automatic: '全自动', single: '单发', semi: '半自动', bolt: '栓动' });
const ZONE_LABELS = Object.freeze({ waiting: '安全区收缩倒计时', shrinking: '安全区正在收缩', finished: '最终安全区' });
const PHASE_LABELS = Object.freeze({ plane: '运输机航行', parachute: '空降部署', ground: '地面行动' });
const SCREENS = ['loading', 'menu', 'playing', 'paused', 'result'];
const ACTIONS = ['start', 'resume', 'restart', 'menu', 'setVolume', 'setQuality', 'setFireMode', 'editTouchLayout'];
const NAVIGATION = new Set(['start', 'resume', 'restart', 'menu']);
const OVERLAYS = ['map', 'inventory', 'help'];
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function number(value, suffix = '') { return finite(value) ? `${Math.round(value)}${suffix}` : '—'; }
function clock(seconds) {
  if (!finite(seconds)) return '--:--';
  const whole = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
function weaponName(weapon) {
  if (!weapon) return '未持有武器';
  if (typeof weapon === 'object') return weapon.name || WEAPON_NAMES[weapon.id] || weapon.id;
  return WEAPON_NAMES[weapon] || String(weapon);
}
function coordinate(value, size) { return (value - MAP_MIN) / MAP_SIZE * size; }
function positionText(position) { return position ? `X ${number(position.x)} / Z ${number(position.z)}` : 'X — / Z —'; }
function circle(ctx, x, y, radius) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, radius), 0, Math.PI * 2); }
function polygon(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
}
function mapContext(canvas) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`无法创建地图 Canvas 2D 上下文：${canvas.id}`);
  return { canvas, context };
}

/** Main owns simulation, game input and pointer lock. HUD owns presentation and menu actions. */
export class HUD {
  constructor(actions) {
    for (const name of ACTIONS) if (typeof actions?.[name] !== 'function') throw new TypeError(`HUD actions.${name} 必须是函数`);
    this.actions = actions;
    this.root = document.getElementById('hud');
    if (!this.root) throw new Error('HUD 契约错误：缺少 #hud');
    this.elements = Object.fromEntries([...this.root.querySelectorAll('[id]')].map(element => [element.id, element]));
    this.screen = 'loading';
    this.mapOpen = false;
    this.inventoryOpen = false;
    this.helpOpen = false;
    this.data = {};
    this.playerName = this.elements['player-name'].value;
    this.textCache = new Map();
    this.valueCache = new Map();
    this.feedTimers = new Map();
    this.toastTimers = new Map();
    this.lastMapDraw = -Infinity;
    this.lastTelemetry = -Infinity;
    this.hitTimer = null;
    this.damageTimer = null;
    this.actionPending = false;
    this.overlayFocus = null;
    this.maps = { mini: mapContext(this.elements.minimap), full: mapContext(this.elements['full-map']) };
    this.menuMap = mapContext(this.elements['menu-map']);
    this.terrainMap = this._createTerrainMap();
    this._buildCompass();
    this._bindActions();
    this._drawMenuMap();
    this.setScreen('loading');
  }

  _text(id, value) {
    const text = value == null ? '—' : String(value);
    if (this.textCache.get(id) === text) return;
    this.elements[id].textContent = text;
    this.textCache.set(id, text);
  }
  _bar(id, value) {
    const progress = finite(value) ? clamp(value, 0, 1) : 0;
    const key = finite(value) ? progress : 'unknown';
    if (this.valueCache.get(id) === key) return;
    const element = this.elements[id];
    element.style.transform = `scaleX(${progress})`;
    if (finite(value)) element.parentElement.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    else element.parentElement.removeAttribute('aria-valuenow');
    this.valueCache.set(id, key);
  }
  _hidden(id, hidden) {
    if (this.elements[id].hidden !== hidden) this.elements[id].hidden = hidden;
  }
  _class(id, name, enabled) {
    const key = `${id}:${name}`;
    if (this.valueCache.get(key) === enabled) return;
    this.elements[id].classList.toggle(name, enabled);
    this.valueCache.set(key, enabled);
  }

  _bindActions() {
    this.elements['start-form'].addEventListener('submit', event => {
      event.preventDefault();
      const input = this.elements['player-name'];
      const name = input.value.trim();
      if (!name || name.length > 16 || /[\u0000-\u001f\u007f]/u.test(name)) {
        input.setCustomValidity('请输入 1–16 字且不含控制字符的行动代号。');
        input.reportValidity();
        return;
      }
      const form = new FormData(event.currentTarget);
      const difficulty = form.get('difficulty');
      const quality = form.get('quality');
      if (!['normal', 'hard'].includes(difficulty) || !['high', 'low'].includes(quality)) {
        this._reportError(new Error('部署参数错误：请选择有效的难度与画质。'));
        return;
      }
      this.playerName = name;
      this._text('hud-player-name', name);
      this.elements['pause-quality'].value = quality;
      this._runAction('start', { difficulty, quality, name });
    });
    this.elements['player-name'].addEventListener('input', event => event.target.setCustomValidity(''));
    this.root.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (!button || !this.root.contains(button)) return;
      if (button.dataset.action) this._runAction(button.dataset.action);
      if (button.dataset.ui === 'help') this.setHelp(true);
      // In-match close buttons are data-touch controls: main must close its own overlay state.
      if (this.screen === 'playing') return;
      const close = button.dataset.close;
      if (close === 'map') this.setMap(false);
      if (close === 'inventory') this.setInventory(false);
      if (close === 'help') this.setHelp(false);
    });
    this.elements['volume-control'].addEventListener('input', event => {
      const volume = Number(event.target.value);
      this._text('volume-value', `${Math.round(volume * 100)}%`);
      this._runAction('setVolume', volume);
    });
    this.elements['pause-quality'].addEventListener('change', event => {
      const quality = event.target.value;
      for (const radio of this.elements['start-form'].querySelectorAll('[name="quality"]')) radio.checked = radio.value === quality;
      this._runAction('setQuality', quality);
    });
    for (const radio of this.elements['start-form'].querySelectorAll('[name="quality"]')) {
      radio.addEventListener('change', event => {
        if (!event.target.checked) return;
        this.elements['pause-quality'].value = event.target.value;
        this._runAction('setQuality', event.target.value);
      });
    }
    // 射击模式：手机没有 B 键，放进暂停菜单；命中自动枪械时才有意义。
    this.elements['pause-fire-mode'].addEventListener('change', event => {
      this._runAction('setFireMode', event.target.value === 'auto');
    });
    // Do not bind data-touch or keyboard handlers: main input is their single owner.
  }

  async _runAction(name, value) {
    if (!ACTIONS.includes(name)) throw new Error(`未知的 HUD action：${name}`);
    const navigation = NAVIGATION.has(name);
    if (navigation && this.actionPending) return;
    if (navigation) { this.actionPending = true; this._navigationDisabled(true); }
    try {
      // Invocation precedes await to preserve the user gesture for audio / pointer lock.
      await this.actions[name](value);
    } catch (error) {
      // Event-boundary failures are explicit and visible, never converted into mock success.
      this._reportError(error);
    } finally {
      if (navigation) { this.actionPending = false; this._navigationDisabled(false); }
    }
  }
  _navigationDisabled(disabled) {
    for (const button of this.root.querySelectorAll('[data-action], .deploy-button')) button.disabled = disabled;
  }
  _reportError(error) {
    console.error('[HUD action failed]', error);
    const panel = document.getElementById('fatal-error');
    panel.textContent = `游戏操作失败：${error instanceof Error ? error.message : String(error)}\n请检查控制台错误详情，修复后重新加载。`;
    panel.hidden = false;
  }

  setScreen(screen) {
    if (!SCREENS.includes(screen)) throw new RangeError(`无效的 HUD screen：${screen}`);
    const previous = this.screen;
    this.screen = screen;
    this.root.dataset.screen = screen;
    for (const name of ['loading', 'menu', 'paused', 'result']) this._hidden(name === 'paused' ? 'pause-screen' : `${name}-screen`, name !== screen);
    this._hidden('game-hud', screen !== 'playing' && screen !== 'paused');
    this.setMap(false); this.setInventory(false); this.setHelp(false);
    if (screen === 'menu' || (screen === 'loading' && previous !== 'loading')) this._resetMatch();
    if (screen === 'playing') {
      this.lastTelemetry = -Infinity;
      this._drawMaps(true);
    }
  }
  setLoading(progress, message) {
    if (!finite(progress)) throw new TypeError('加载进度必须是有限数值');
    const value = clamp(progress, 0, 1);
    this._bar('loading-fill', value);
    this._text('loading-percent', `${Math.round(value * 100)}%`);
    this._text('loading-message', message);
  }

  /** Initialization may be partial. All displayed match data comes from main. */
  update(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('HUD.update 需要状态对象');
    Object.assign(this.data, data);
    const state = this.data;
    this._text('alive-value', number(state.alive));
    this._text('kills-value', number(state.kills));
    this._text('phase-label', PHASE_LABELS[state.phase] || '等待部署');
    this._text('match-time', clock(state.time));
    this._text('health-value', number(state.health));
    this._bar('health-fill', state.health / 100);
    this._class('health-status', 'is-low', finite(state.health) && state.health <= 25);
    this._text('armor-value', finite(state.armor) ? `Lv.${state.armor}` : '—');
    this._text('helmet-value', finite(state.helmet) ? `Lv.${state.helmet}` : '—');
    this._bar('boost-fill', state.boost / 100);
    this._text('boost-value', finite(state.boost) ? `能量 ${Math.round(state.boost)}` : '能量 —');
    for (const key of ['medkits', 'boosts', 'grenades', 'rounds', 'reserve']) this._text(`${key}-value`, number(state[key]));
    this._text('weapon-name', state.weapon ?? '未持有武器');
    this._class('reticle', 'is-aiming', !!state.aim);
    this._class('reticle', 'is-scoped', !!state.aim && state.weaponId === 'kar98');
    this._text('fire-mode', FIRE_MODES[state.fireMode] || state.fireMode || '—');
    for (let index = 0; index < 2; index += 1) {
      const slot = state.slots?.[index];
      this._text(`slot-${index + 1}-name`, slot ? weaponName(slot.id) : '空武器位');
      this._text(`slot-${index + 1}-rounds`, slot ? number(slot.rounds) : '—');
      this._class(`weapon-slot-${index + 1}`, 'is-active', state.slot === index);
    }
    this._hidden('vehicle-status', !state.vehicle);
    this._hidden('reticle', state.phase !== 'ground' || !!state.vehicle);
    this._updateCompass(state.heading);
    this._updateZone(state.zone);
    this._updatePrompt(state.prompt, state.action);
    this._hidden('air-status', state.phase !== 'plane' && state.phase !== 'parachute');
    this._text('air-phase', state.phase === 'parachute' ? '距地高度' : '离机倒计时');
    this._text('air-time', finite(state.airTime) ? `${Math.max(0, Math.ceil(state.airTime))} ${state.phase === 'parachute' ? 'm' : 's'}` : '—');
    this._text('air-note', state.phase === 'parachute'
      ? (state.touch ? '摇杆控制落点 · 低空自动开伞' : 'WASD 控制落点 · 低空自动开伞')
      : (state.touch ? '观察落点 · 选择跳伞时机' : '观察落点 · F 离开运输机'));
    this._updateAirdrop(state.phase, state.chute);
    // 暂停菜单里的射击模式下拉要与当前状态一致（按 B 或菜单切换后都同步）
    if (state.fireMode) {
      const auto = state.fireMode === '自动' || state.fireMode === '全自动';
      const select = this.elements['pause-fire-mode'];
      const want = auto ? 'auto' : 'single';
      if (select.value !== want) select.value = want;
    }
    // 手机没有 V 键，切视角改为可点按钮；触屏上按键提示（M/V/Esc）也没意义，用 body.is-touch 隐藏。
    this._hidden('touch-view', !state.touch);
    document.body.classList.toggle('is-touch', !!state.touch);
    const now = performance.now();
    if (now - this.lastTelemetry >= 200) {
      this.lastTelemetry = now;
      this._text('fps-value', finite(state.fps) ? `${Math.round(state.fps)} FPS` : '');
      this._text('speed-value', finite(state.speed) ? `${Math.round(state.speed)} km/h` : '— km/h');
      this._text('position-value', positionText(state.position));
      if (this.mapOpen) this._text('map-position', positionText(state.position));
    }
    if (this.inventoryOpen) this._updateInventory();
    this._drawMaps(false, now);
  }
  _buildCompass() {
    const fragment = document.createDocumentFragment();
    const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let degrees = -360; degrees <= 720; degrees += 15) {
      const tick = document.createElement('span');
      const bearing = ((degrees % 360) + 360) % 360;
      tick.className = `compass-tick${bearing % 45 === 0 ? ' cardinal' : ''}`;
      tick.style.left = `${degrees * COMPASS_SCALE}px`;
      tick.textContent = bearing % 45 === 0 ? labels[bearing / 45] : String(bearing);
      fragment.append(tick);
    }
    this.elements['compass-strip'].append(fragment);
  }
  // heading is a compass bearing in degrees: north=0, east=90.
  _updateCompass(heading) {
    if (!finite(heading)) { this._text('heading-value', '—'); return; }
    const degrees = ((heading % 360) + 360) % 360;
    const rounded = Math.round(degrees * 10) / 10;
    this._text('heading-value', `${Math.round(degrees) % 360}°`);
    if (this.valueCache.get('heading') === rounded) return;
    this.elements['compass-strip'].style.transform = `translateX(${-rounded * COMPASS_SCALE}px)`;
    this.valueCache.set('heading', rounded);
  }
  _updateZone(zone) {
    const label = zone ? ZONE_LABELS[zone.mode] || zone.mode : '等待安全区';
    this._text('zone-label', label);
    this._text('zone-timer', clock(zone?.remaining));
    this._class('zone-status', 'is-shrinking', zone?.mode === 'shrinking');
    if (!this.mapOpen) return;
    this._text('map-zone-label', zone ? `阶段 ${number(zone.phase + 1)} · ${label}` : label);
    this._text('map-zone-timer', clock(zone?.remaining));
    this._text('map-zone-radius', number(zone?.radius, ' m'));
    this._text('map-next-radius', number(zone?.nextRadius, ' m'));
  }
  /**
   * 手机没有空格键，跳伞/开伞必须给一个可点的按钮。
   * 运输机阶段显示「跳伞」，自由落体阶段显示「开伞」，开伞后隐藏。
   */
  _updateAirdrop(phase, chute) {
    const button = this.elements['touch-airdrop'];
    if (!button) return;
    const label = phase === 'plane' ? '跳伞' : '开伞';
    const hint = phase === 'plane' ? '离开运输机' : '展开降落伞';
    const visible = phase === 'plane' || (phase === 'parachute' && !chute);
    this._text('touch-airdrop-label', label);
    this._text('touch-airdrop-hint', hint);
    button.setAttribute('aria-label', hint);
    this._hidden('touch-airdrop', !visible);
    this._class('touch-airdrop', 'is-parachute', phase === 'parachute');
  }
  _updatePrompt(prompt, action) {
    this._hidden('interaction-prompt', !prompt);
    this._text('prompt-text', prompt || '');
    this._hidden('action-progress', !action);
    if (!action) return;
    this._text('action-label', action.label);
    this._bar('action-fill', action.progress);
    this._text('action-percent', finite(action.progress) ? `${Math.round(clamp(action.progress, 0, 1) * 100)}%` : '—');
  }
  _updateInventory() {
    const state = this.data;
    for (let index = 0; index < 2; index += 1) {
      const slot = state.slots?.[index];
      this._text(`inventory-weapon-${index + 1}`, slot ? weaponName(slot.id) : '空武器位');
      this._text(`inventory-rounds-${index + 1}`, slot ? `弹匣内 ${number(slot.rounds)} 发` : '尚未装备');
      this._class(`inventory-slot-${index + 1}`, 'is-active', state.slot === index);
      this._class(`inventory-slot-${index + 1}`, 'is-empty', !slot);
    }
    for (const key of ['armor', 'helmet', 'medkits', 'boosts', 'grenades', 'reserve']) {
      this._text(`inventory-${key}`, finite(state[key]) && ['armor', 'helmet'].includes(key) ? `Lv.${state[key]}` : number(state[key]));
    }
  }
  feed(text) { this._notice('kill-feed', 'feed-entry', String(text), this.feedTimers, 5, 6500); }
  toast(text, tone = 'info') { this._notice('toast-stack', 'toast', String(text), this.toastTimers, 3, 3500, tone); }
  _notice(containerId, className, text, timers, limit, lifetime, tone) {
    const container = this.elements[containerId];
    while (container.children.length >= limit) {
      const first = container.firstElementChild;
      clearTimeout(timers.get(first)); timers.delete(first); first.remove();
    }
    const item = document.createElement('div');
    item.className = className;
    item.textContent = text;
    if (tone) item.dataset.tone = tone;
    container.append(item);
    timers.set(item, setTimeout(() => { item.remove(); timers.delete(item); }, lifetime));
  }
  hit(headshot = false) {
    clearTimeout(this.hitTimer);
    this._class('hit-marker', 'is-headshot', !!headshot);
    this._class('hit-marker', 'is-active', true);
    this.hitTimer = setTimeout(() => this._class('hit-marker', 'is-active', false), headshot ? 240 : 140);
  }
  // Relative incoming direction in radians. Zero displays the damage arc in front.
  damage(angle = 0) {
    if (!finite(angle)) throw new TypeError('伤害方向必须是有限数值');
    clearTimeout(this.damageTimer);
    this.elements['damage-ring'].style.transform = `rotate(${angle}rad)`;
    this._class('damage-ring', 'is-active', true);
    this._class('damage-vignette', 'is-active', true);
    this.damageTimer = setTimeout(() => {
      this._class('damage-ring', 'is-active', false);
      this._class('damage-vignette', 'is-active', false);
    }, 420);
  }
  setMap(open) {
    this._setOverlay('map', open);
    if (!this.mapOpen) return;
    this._updateZone(this.data.zone);
    this._text('map-position', positionText(this.data.position));
    this._drawMaps(true);
  }
  setInventory(open) {
    this._setOverlay('inventory', open);
    if (this.inventoryOpen) this._updateInventory();
  }
  setHelp(open) { this._setOverlay('help', open); }
  _setOverlay(name, open) {
    const enabled = !!open;
    if (this[`${name}Open`] === enabled) return;
    if (enabled) {
      if (!OVERLAYS.some(key => this[`${key}Open`])) this.overlayFocus = document.activeElement;
      for (const other of OVERLAYS) {
        this[`${other}Open`] = other === name;
        this._hidden(`${other}-overlay`, other !== name);
      }
    } else {
      this[`${name}Open`] = false;
      this._hidden(`${name}-overlay`, true);
    }
    const anyOpen = OVERLAYS.some(key => this[`${key}Open`]);
    for (const id of ['loading-screen', 'menu-screen', 'game-hud', 'pause-screen', 'result-screen']) this.elements[id].inert = anyOpen;
    if (enabled && !document.pointerLockElement) this.elements[`${name}-overlay`].querySelector('button').focus({ preventScroll: true });
    if (!enabled && !anyOpen && this.overlayFocus?.isConnected && !this.overlayFocus.closest('[hidden]')) this.overlayFocus.focus({ preventScroll: true });
  }
  showResult({ win, rank, kills, time, damage, name }) {
    this._class('result-dialog', 'is-win', !!win);
    this._text('result-eyebrow', win ? 'MISSION ACCOMPLISHED / 行动成功' : 'AFTER ACTION REPORT / 行动战报');
    this._text('result-title', win ? '胜利属于你' : '行动结束');
    this._text('result-subtitle', win ? '你守住了最后的安全区，成为最后的幸存者。' : '这一程到此为止。整理战报，准备下一次出发。');
    this._text('result-name', name ?? this.playerName);
    this._text('result-rank', finite(rank) ? `#${Math.round(rank)}` : '—');
    this._text('result-kills', number(kills));
    this._text('result-time', clock(time));
    this._text('result-damage', number(damage));
    this.setScreen('result');
  }
  _resetMatch() {
    this.data = {};
    this.lastMapDraw = -Infinity;
    this.lastTelemetry = -Infinity;
    for (const timers of [this.feedTimers, this.toastTimers]) {
      for (const [element, timer] of timers) { clearTimeout(timer); element.remove(); }
      timers.clear();
    }
    clearTimeout(this.hitTimer); clearTimeout(this.damageTimer);
    for (const id of ['hit-marker', 'damage-ring', 'damage-vignette']) this._class(id, 'is-active', false);
    this.update({});
  }
  _drawMaps(force = false, now = performance.now()) {
    if (this.screen !== 'playing' && !this.mapOpen) return;
    if (!force && now - this.lastMapDraw < MAP_REFRESH_MS) return;
    this.lastMapDraw = now;
    this._drawMap(this.maps.mini, false);
    if (this.mapOpen) this._drawMap(this.maps.full, true);
  }
  _prepareCanvas({ canvas, context }) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.min(1400, Math.round(rect.width * ratio)));
    const height = Math.max(1, Math.min(1400, Math.round(rect.height * ratio)));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    return { width: rect.width, height: rect.height };
  }
  _drawMap(map, full) {
    const size = this._prepareCanvas(map);
    if (!size) return;
    const { context: ctx } = map;
    const { width, height } = size;
    const state = this.data;
    ctx.fillStyle = '#121d17'; ctx.fillRect(0, 0, width, height);
    ctx.drawImage(this.terrainMap, 0, 0, width, height);
    this._drawGrid(ctx, width, height, full);
    if (state.zone) this._drawZone(ctx, width, height, state.zone, full);
    if (state.locations) this._drawLocations(ctx, width, height, state.locations, full);
    if (state.markers) for (const marker of state.markers) {
      if (marker.type !== 'player' || !state.position) this._drawMarker(ctx, width, height, marker, full, 0);
    }
    if (state.position) this._drawMarker(ctx, width, height, { ...state.position, type: 'player' }, full, state.heading);
    if (!state.position && !state.locations && !state.zone) {
      ctx.textAlign = 'center'; ctx.font = `${full ? 13 : 9}px "Microsoft YaHei",sans-serif`; ctx.fillStyle = '#8c9c80';
      ctx.fillText('等待战场坐标', width / 2, height / 2);
    }
    if (full) {
      const y = height - 36; const length = 200 / MAP_SIZE * width;
      ctx.strokeStyle = '#c7d1b497'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(18, y - 4); ctx.lineTo(18, y); ctx.lineTo(18 + length, y); ctx.lineTo(18 + length, y - 4); ctx.stroke();
      ctx.fillStyle = '#8c9c80'; ctx.font = '8px Consolas,monospace'; ctx.textAlign = 'left'; ctx.fillText('200 m', 18, y - 8);
    }
  }
  _drawGrid(ctx, width, height, full) {
    ctx.save(); ctx.strokeStyle = '#b7c69c15'; ctx.lineWidth = 1;
    for (let index = 1; index < 7; index += 1) {
      const x = index / 7 * width; const y = index / 7 * height;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (full) {
      ctx.font = '9px Consolas,monospace'; ctx.fillStyle = '#a4b18a88'; ctx.textAlign = 'center';
      for (let index = 0; index < 7; index += 1) {
        ctx.fillText(String.fromCharCode(65 + index), (index + .5) / 7 * width, 14);
        ctx.fillText(String(index + 1), 12, (index + .5) / 7 * height);
      }
    }
    ctx.restore();
  }
  _drawLocations(ctx, width, height, locations, full) {
    ctx.save();
    for (const location of locations) {
      const x = coordinate(location.x, width); const y = coordinate(location.z, height);
      const radius = finite(location.radius) ? location.radius / MAP_SIZE * width : 0;
      ctx.fillStyle = '#bdcba413'; ctx.strokeStyle = '#bdcba42f'; ctx.lineWidth = 1;
      circle(ctx, x, y, radius); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#aeb996'; ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    ctx.font = `${full ? 11 : 8}px "Microsoft YaHei",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const location of locations) {
      const label = String(location.name);
      const halfWidth = ctx.measureText(label).width / 2;
      const x = clamp(coordinate(location.x, width), halfWidth + 5, width - halfWidth - 5);
      const y = clamp(coordinate(location.z, height) - 6, full ? 29 : 15, height - 15);
      ctx.lineWidth = full ? 4 : 3; ctx.strokeStyle = '#0d160fea'; ctx.strokeText(label, x, y);
      ctx.fillStyle = full ? '#ced7bf' : '#c4ceb1'; ctx.fillText(label, x, y);
    }
    ctx.restore();
  }
  _drawZone(ctx, width, height, zone, full) {
    ctx.save();
    const x = coordinate(zone.x, width); const y = coordinate(zone.z, height);
    const radius = zone.radius / MAP_SIZE * width;
    ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.moveTo(x + radius, y); ctx.arc(x, y, Math.max(0, radius), 0, Math.PI * 2);
    ctx.fillStyle = '#58677740'; ctx.fill('evenodd');
    ctx.strokeStyle = '#edf0df'; ctx.lineWidth = full ? 1.8 : 1.2;
    circle(ctx, x, y, radius); ctx.stroke();
    if (finite(zone.nextRadius) && finite(zone.nextX) && finite(zone.nextZ)) {
      ctx.strokeStyle = GOLD; ctx.setLineDash(full ? [7, 5] : [3, 3]);
      circle(ctx, coordinate(zone.nextX, width), coordinate(zone.nextZ, height), zone.nextRadius / MAP_SIZE * width); ctx.stroke();
      ctx.setLineDash([]);
    }
    const player = this.data.position;
    if (player && (player.x - zone.x) ** 2 + (player.z - zone.z) ** 2 > zone.radius ** 2) {
      ctx.beginPath(); ctx.moveTo(coordinate(player.x, width), coordinate(player.z, height)); ctx.lineTo(x, y);
      ctx.setLineDash([3, 4]); ctx.strokeStyle = '#f3c87999'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();
  }
  _drawMarker(ctx, width, height, marker, full, heading) {
    ctx.save(); ctx.translate(coordinate(marker.x, width), coordinate(marker.z, height)); ctx.lineWidth = full ? 1.5 : 1;
    if (marker.type === 'player') {
      const size = full ? 8 : 5;
      ctx.rotate((finite(heading) ? heading : 0) * Math.PI / 180);
      circle(ctx, 0, 0, size + 5); ctx.fillStyle = '#e6bd6018'; ctx.fill();
      polygon(ctx, [[0, -size], [size * .75, size], [0, size * .5], [-size * .75, size]]);
      ctx.fillStyle = GOLD; ctx.strokeStyle = '#161c12'; ctx.fill(); ctx.stroke();
    } else if (marker.type === 'vehicle') {
      const size = full ? 5 : 3;
      ctx.fillStyle = '#9caeaa'; ctx.strokeStyle = '#dee7df';
      ctx.fillRect(-size, -size * .7, size * 2, size * 1.4); ctx.strokeRect(-size, -size * .7, size * 2, size * 1.4);
    } else if (marker.type === 'enemy') {
      const size = full ? 5 : 3;
      polygon(ctx, [[0, -size], [size, 0], [0, size], [-size, 0]]);
      ctx.fillStyle = '#ed816b'; ctx.strokeStyle = '#331e17'; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  _createTerrainMap() {
    const canvas = document.createElement('canvas');
    canvas.width = TERRAIN_RESOLUTION;
    canvas.height = TERRAIN_RESOLUTION;
    const { context: ctx } = mapContext(canvas);
    const image = ctx.createImageData(TERRAIN_RESOLUTION, TERRAIN_RESOLUTION);
    // Cache the authoritative height field once. Per-frame maps only composite this texture.
    for (let row = 0; row < TERRAIN_RESOLUTION; row += 1) {
      for (let col = 0; col < TERRAIN_RESOLUTION; col += 1) {
        const x = MAP_MIN + (col + .5) / TERRAIN_RESOLUTION * MAP_SIZE;
        const z = MAP_MIN + (row + .5) / TERRAIN_RESOLUTION * MAP_SIZE;
        const elevation = heightAt(x, z);
        const shade = clamp(elevation, 0, 85) / 85;
        const color = elevation <= 0 ? [21, 31, 33] : elevation < 3 ? [112, 107, 78] : [53 + shade * 43, 59 + shade * 39, 42 + shade * 31];
        const offset = (row * TERRAIN_RESOLUTION + col) * 4;
        image.data[offset] = color[0];
        image.data[offset + 1] = color[1];
        image.data[offset + 2] = color[2];
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }
  _drawMenuMap() {
    const { canvas, context: ctx } = this.menuMap;
    const width = canvas.width; const height = canvas.height;
    const size = Math.min(width, height) - 32;
    ctx.clearRect(0, 0, width, height);
    this._drawGrid(ctx, width, height, false);
    ctx.save();
    ctx.translate((width - size) / 2, (height - size) / 2);
    ctx.drawImage(this.terrainMap, 0, 0, size, size);
    this._drawLocations(ctx, size, size, LOCATIONS, false);
    ctx.restore();
    ctx.font = '9px Consolas,monospace'; ctx.fillStyle = '#b4c095aa'; ctx.textAlign = 'left';
    ctx.fillText('ISLAND / TERRAIN RECON', 14, 20);
  }
}
