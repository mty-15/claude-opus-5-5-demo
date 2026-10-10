// Rules are the single source of truth for weapon, capacity and zone balancing.
export const AMMO_TYPES = Object.freeze(['556', '762', '9mm']);

export const WEAPONS = Object.freeze(Object.fromEntries([
  { id: 'm416', name: 'M416', ammo: '556', damage: 41, headMultiplier: 2.3,
    fireInterval: 0.086, reloadTime: 2.1, magSize: 30, spread: 0.006,
    range: 260, automatic: true, color: 0x879b78 },
  { id: 'akm', name: 'AKM', ammo: '762', damage: 49, headMultiplier: 2.3,
    fireInterval: 0.1, reloadTime: 2.5, magSize: 30, spread: 0.01,
    range: 240, automatic: true, color: 0xb18c64 },
  { id: 'ump45', name: 'UMP45', ammo: '9mm', damage: 35, headMultiplier: 2,
    fireInterval: 0.09, reloadTime: 1.9, magSize: 25, spread: 0.009,
    range: 160, automatic: true, color: 0x789eac },
  { id: 'kar98', name: 'Kar98k', ammo: '762', damage: 79, headMultiplier: 2.5,
    fireInterval: 1.3, reloadTime: 3.2, magSize: 5, spread: 0.0012,
    range: 600, automatic: false, color: 0xbc9871 },
].map(weapon => [weapon.id, Object.freeze(weapon)])));

const SLOT_COUNT = 2;
const MAX_HEALTH = 100;
const RESERVE_CAPACITY = 500;
const DEFAULT_AMMO_PICKUP = 30;
const STACKS = Object.freeze({
  medkit: Object.freeze({ field: 'medkits', capacity: 5, name: '医疗包' }),
  boost: Object.freeze({ field: 'boosts', capacity: 5, name: '能量饮料' }),
  grenade: Object.freeze({ field: 'grenades', capacity: 3, name: '手雷' }),
});
const DAMAGE_REDUCTION = Object.freeze([0, 0.3, 0.4, 0.55]);
const MAX_EQUIPMENT_LEVEL = DAMAGE_REDUCTION.length - 1;
const INITIAL_RADIUS = 620;
const DIRECTION_TOLERANCE = 1e-6;
const AXES = Object.freeze(['x', 'y', 'z']);

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function number(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
}

function integer(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  number(value, name, min, max);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}

function weaponFor(id) {
  if (typeof id !== 'string' || !Object.hasOwn(WEAPONS, id)) {
    throw new RangeError(`Unknown weapon id: ${String(id)}`);
  }
  return WEAPONS[id];
}

function ammoType(id) {
  if (!AMMO_TYPES.includes(id)) throw new RangeError(`Unknown ammo id: ${String(id)}`);
  return id;
}

function equipmentLevel(value, name, min = 0) {
  integer(value, name, min, MAX_EQUIPMENT_LEVEL);
}

function validateInventory(inventory) {
  object(inventory, 'inventory');
  if (!Array.isArray(inventory.slots) || inventory.slots.length !== SLOT_COUNT) {
    throw new TypeError(`inventory.slots must contain exactly ${SLOT_COUNT} slots`);
  }
  // Indexed iteration also rejects sparse slots instead of silently skipping them.
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const slot = inventory.slots[index];
    if (slot === null) continue;
    object(slot, `inventory.slots[${index}]`);
    integer(slot.rounds, 'slot.rounds', 0, weaponFor(slot.id).magSize);
  }
  integer(inventory.active, 'inventory.active', 0, SLOT_COUNT - 1);
  object(inventory.ammo, 'inventory.ammo');
  for (const id of Object.keys(inventory.ammo)) ammoType(id);
  for (const id of AMMO_TYPES) integer(inventory.ammo[id], `ammo.${id}`, 0, RESERVE_CAPACITY);
  for (const { field, capacity } of Object.values(STACKS)) {
    integer(inventory[field], `inventory.${field}`, 0, capacity);
  }
  equipmentLevel(inventory.armor, 'inventory.armor');
  equipmentLevel(inventory.helmet, 'inventory.helmet');
}

function copyInventory(inventory) {
  return {
    ...inventory,
    slots: inventory.slots.map(slot => slot === null ? null : { ...slot }),
    ammo: { ...inventory.ammo },
  };
}

export function createInventory() {
  return {
    slots: Array(SLOT_COUNT).fill(null), active: 0,
    ammo: Object.fromEntries(AMMO_TYPES.map(id => [id, 0])),
    medkits: 0, boosts: 0, armor: 0, helmet: 0, grenades: 0,
  };
}

function pickupResult(inventory, accepted, message) {
  return { inventory, accepted, message };
}

function addStack(inventory, { field, capacity, name }, amount, ammoId) {
  const current = ammoId === undefined ? inventory[field] : inventory.ammo[ammoId];
  const added = Math.min(amount, capacity - current);
  if (added === 0) return pickupResult(inventory, false, `${name}已满（上限 ${capacity}）`);
  const next = copyInventory(inventory);
  if (ammoId === undefined) next[field] += added;
  else next.ammo[ammoId] += added;
  const full = current + added === capacity ? `，已满（上限 ${capacity}）` : '';
  const remainder = added < amount ? `，剩余 ${amount - added} 未拾取` : '';
  return pickupResult(next, true, `已拾取 ${name} ×${added}${full}${remainder}`);
}

function addAmmo(inventory, id, amount) {
  return addStack(inventory, { capacity: RESERVE_CAPACITY, name: `${id} 弹药` }, amount, id);
}

export function addLoot(inventory, loot) {
  validateInventory(inventory);
  object(loot, 'loot');
  const { kind, id, amount, level } = loot;
  if (typeof kind !== 'string' ||
      !(['weapon', 'ammo', 'armor', 'helmet'].includes(kind) || Object.hasOwn(STACKS, kind))) {
    throw new RangeError(`Unknown loot kind: ${String(kind)}`);
  }
  // Optional fields have defaults only when omitted, never for invalid supplied values.
  if (amount !== undefined) integer(amount, 'loot.amount', 1);
  if (level !== undefined) equipmentLevel(level, 'loot.level', 1);
  if (kind === 'weapon') {
    const weapon = weaponFor(id);
    const rounds = loot.rounds === undefined ? weapon.magSize : loot.rounds;
    integer(rounds, 'loot.rounds', 0, weapon.magSize);
    if (inventory.slots.some(slot => slot?.id === id)) {
      if (rounds === 0) return pickupResult(inventory, false, `${weapon.name} 弹匣为空，无可拾取弹药`);
      return addAmmo(inventory, weapon.ammo, rounds);
    }
    const free = inventory.slots.indexOf(null);
    const index = free === -1 ? inventory.active : free;
    const replaced = inventory.slots[index];
    const next = copyInventory(inventory);
    next.slots[index] = { id, rounds };
    if (inventory.slots[inventory.active] === null) next.active = index;
    return pickupResult(next, true, replaced
      ? `武器槽已满，已用 ${weapon.name} 替换 ${WEAPONS[replaced.id].name}`
      : `已拾取 ${weapon.name}`);
  }
  if (kind === 'ammo') return addAmmo(inventory, ammoType(id), amount === undefined ? DEFAULT_AMMO_PICKUP : amount);
  if (kind === 'armor' || kind === 'helmet') {
    const targetLevel = level === undefined ? 1 : level;
    const name = kind === 'armor' ? '护甲' : '头盔';
    if (targetLevel <= inventory[kind]) {
      return pickupResult(inventory, false, `${name}无需更换（已有 ${inventory[kind]} 级，上限 ${MAX_EQUIPMENT_LEVEL} 级）`);
    }
    return pickupResult({ ...copyInventory(inventory), [kind]: targetLevel }, true, `已装备 ${targetLevel} 级${name}`);
  }
  return addStack(inventory, STACKS[kind], amount === undefined ? 1 : amount);
}

export function reloadWeapon(inventory) {
  validateInventory(inventory);
  const slot = inventory.slots[inventory.active];
  if (slot === null) return inventory;
  const weapon = WEAPONS[slot.id];
  const transferred = Math.min(weapon.magSize - slot.rounds, inventory.ammo[weapon.ammo]);
  if (transferred === 0) return inventory;
  const next = copyInventory(inventory);
  next.slots[inventory.active].rounds += transferred;
  next.ammo[weapon.ammo] -= transferred;
  return next;
}

export function consumeRound(inventory) {
  validateInventory(inventory);
  const slot = inventory.slots[inventory.active];
  if (slot === null || slot.rounds === 0) return inventory;
  const next = copyInventory(inventory);
  next.slots[inventory.active].rounds -= 1;
  return next;
}

export function applyDamage(target, raw, options = {}) {
  object(target, 'target');
  object(options, 'damage options');
  const { health, armor, helmet } = target;
  const { headshot = false, zone = false } = options;
  number(health, 'health', 0, MAX_HEALTH);
  equipmentLevel(armor, 'armor');
  equipmentLevel(helmet, 'helmet');
  number(raw, 'raw damage', 0);
  if (typeof headshot !== 'boolean' || typeof zone !== 'boolean') {
    throw new TypeError('headshot and zone must be booleans');
  }
  const protection = zone ? 0 : DAMAGE_REDUCTION[headshot ? helmet : armor];
  // raw already includes any weapon/head multiplier; damage reports actual HP lost.
  const damage = Math.min(health, raw * (1 - protection));
  return { health: health - damage, armor, helmet, damage };
}

export const ZONE_PHASES = Object.freeze([
  { wait: 85, shrink: 55, radius: 450, damage: 1 },
  { wait: 65, shrink: 50, radius: 300, damage: 2 },
  { wait: 50, shrink: 45, radius: 180, damage: 3 },
  { wait: 40, shrink: 40, radius: 90, damage: 5 },
  { wait: 30, shrink: 35, radius: 40, damage: 8 },
  { wait: 25, shrink: 30, radius: 12, damage: 12 },
  { wait: 20, shrink: 30, radius: 0, damage: 20 },
].map(Object.freeze));
const ZONE_DURATION = ZONE_PHASES.reduce((total, phase) => total + phase.wait + phase.shrink, 0);

export function mulberry32(seed) {
  integer(seed, 'seed');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

export function createZone(seed = 2026) {
  integer(seed, 'seed');
  // Opaque state: geometry is derived, not duplicated in mutable current/target fields.
  return { seed: seed >>> 0, elapsed: 0 };
}

function validateZone(state) {
  object(state, 'zone state');
  integer(state.seed, 'zone.seed', 0, 0xffffffff);
  number(state.elapsed, 'zone.elapsed', 0, ZONE_DURATION);
}

export function advanceZone(state, dt) {
  validateZone(state);
  number(dt, 'dt', 0);
  return { seed: state.seed, elapsed: Math.min(ZONE_DURATION, state.elapsed + dt) };
}

export function zoneSnapshot(state) {
  validateZone(state);
  const random = mulberry32(state.seed);
  let previous = { x: 0, z: 0, radius: INITIAL_RADIUS };
  let elapsed = state.elapsed;
  for (let phase = 0; phase < ZONE_PHASES.length; phase += 1) {
    const { wait, shrink, radius, damage } = ZONE_PHASES[phase];
    const angle = random() * Math.PI * 2;
    const offset = Math.sqrt(random()) * (previous.radius - radius);
    const target = {
      x: previous.x + Math.cos(angle) * offset,
      z: previous.z + Math.sin(angle) * offset,
      radius,
    };
    const duration = wait + shrink;
    if (elapsed < duration) {
      const waiting = elapsed < wait;
      const progress = waiting ? 0 : (elapsed - wait) / shrink;
      return {
        x: previous.x + (target.x - previous.x) * progress,
        z: previous.z + (target.z - previous.z) * progress,
        radius: previous.radius + (radius - previous.radius) * progress,
        nextX: target.x, nextZ: target.z, nextRadius: radius, phase,
        mode: waiting ? 'waiting' : 'shrinking',
        remaining: waiting ? wait - elapsed : duration - elapsed,
        damage,
      };
    }
    elapsed -= duration;
    previous = target;
  }
  return {
    ...previous, nextX: previous.x, nextZ: previous.z, nextRadius: previous.radius,
    phase: ZONE_PHASES.length - 1, mode: 'finished', remaining: 0,
    damage: ZONE_PHASES.at(-1).damage,
  };
}

export function isOutsideZone(x, z, snapshot) {
  number(x, 'x');
  number(z, 'z');
  object(snapshot, 'zone snapshot');
  number(snapshot.x, 'snapshot.x');
  number(snapshot.z, 'snapshot.z');
  number(snapshot.radius, 'snapshot.radius', 0);
  // The final point is not a permanent safe spot: the finished zone damages everyone.
  return snapshot.radius === 0 || Math.hypot(x - snapshot.x, z - snapshot.z) > snapshot.radius;
}

function validateVector(vector, name) {
  object(vector, name);
  for (const axis of AXES) number(vector[axis], `${name}.${axis}`);
}

export function rayBoxDistance(origin, direction, box, maxDistance = Infinity) {
  validateVector(origin, 'origin');
  validateVector(direction, 'direction');
  if (Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) > DIRECTION_TOLERANCE) {
    throw new RangeError('direction must be normalized (unit length)');
  }
  object(box, 'box');
  for (const axis of AXES) {
    const suffix = axis.toUpperCase();
    number(box[`min${suffix}`], `box.min${suffix}`);
    number(box[`max${suffix}`], `box.max${suffix}`, box[`min${suffix}`]);
  }
  if (maxDistance !== Infinity) number(maxDistance, 'maxDistance', 0);
  let entry = 0;
  let exit = maxDistance;
  for (const axis of AXES) {
    const min = box[`min${axis.toUpperCase()}`];
    const max = box[`max${axis.toUpperCase()}`];
    // An exactly parallel axis has no slab crossing; do not replace small slopes by zero.
    if (direction[axis] === 0) {
      if (origin[axis] < min || origin[axis] > max) return null;
      continue;
    }
    const first = (min - origin[axis]) / direction[axis];
    const second = (max - origin[axis]) / direction[axis];
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return null;
  }
  if (!Number.isFinite(entry)) throw new RangeError('Ray intersection distance exceeds the finite numeric range');
  // A ray starting in/on the box intersects at its origin, not at the exit face.
  return entry;
}

export function formatTime(seconds) {
  number(seconds, 'seconds', 0, Number.MAX_SAFE_INTEGER);
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
