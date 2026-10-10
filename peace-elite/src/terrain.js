// Shared deterministic terrain and navigation surface. No THREE, DOM or global RNG.
export const MAP_SIZE = 1400;
export const SEA_LEVEL = 0;

const clamp01 = value => Math.max(0, Math.min(1, value));
export const smoothstep = (low, high, value) => {
  const t = clamp01((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};

export const LOCATIONS = Object.freeze([
  { id: 'cape-harbor', name: '海岬港', x: -345, z: -270, radius: 70, color: '#e8ae6a', elevation: 10, kind: 'harbor' },
  { id: 'blue-town', name: '青瓦镇', x: -95, z: -225, radius: 78, color: '#86b9da', elevation: 17, kind: 'town' },
  { id: 'north-ridge', name: '北岭哨站', x: 165, z: -365, radius: 58, color: '#bccbb0', elevation: 38, kind: 'outpost' },
  { id: 'wheat-farm', name: '麦穗农庄', x: 300, z: -155, radius: 78, color: '#e4cc78', elevation: 14, kind: 'farm' },
  { id: 'central-town', name: '中央集镇', x: 0, z: 0, radius: 85, color: '#dc9b87', elevation: 18, kind: 'town' },
  { id: 'tidal-depot', name: '落潮仓储', x: -365, z: 45, radius: 72, color: '#9ebdc2', elevation: 11, kind: 'depot' },
  { id: 'pine-camp', name: '松风营地', x: -160, z: 320, radius: 68, color: '#96b59b', elevation: 19, kind: 'camp' },
  { id: 'white-bay', name: '白沙湾', x: 125, z: 390, radius: 68, color: '#ead7a5', elevation: 9, kind: 'coast' },
  { id: 'east-bridge', name: '东桥村', x: 350, z: 65, radius: 68, color: '#a9bfdb', elevation: 14, kind: 'village' },
].map(location => Object.freeze(location)));

export const riverCenterAt = x => 205 + 22 * Math.sin((x + 30) / 120);
export const BRIDGES = Object.freeze([-220, 130].map((x, index) => Object.freeze({
  id: `bridge-${index}`, x, z: riverCenterAt(x), width: 12, length: 84, height: 7,
})));

const nodes = [...LOCATIONS.map(location => ({
  x: location.x, z: location.z, height: location.elevation, flat: location.radius - 20,
})), ...BRIDGES.flatMap(bridge => [-60, -bridge.length / 2, bridge.length / 2, 60].map(offset => ({
  x: bridge.x, z: bridge.z + offset, height: bridge.height, flat: 0,
})))];
const connections = [
  [0, 1], [0, 5], [1, 2], [1, 4], [2, 3], [3, 4], [3, 8], [4, 5], [4, 8],
  // Straight approach aprons keep the full driving lane clear of the bridge guardrails.
  [5, 9], [4, 9], [9, 10], [10, 11, true], [11, 12], [12, 6], [6, 7],
  [4, 13], [8, 13], [13, 14], [14, 15, true], [15, 16], [16, 7],
];
export const ROADS = Object.freeze(connections.map(([from, to, bridge = false]) => {
  const a = nodes[from];
  const b = nodes[to];
  return Object.freeze({ a: Object.freeze(a), b: Object.freeze(b), bridge, width: 8.5,
    length: Math.hypot(b.x - a.x, b.z - a.z) });
}));

export const FIELD_PLOTS = Object.freeze([
  { x: 328, z: -187, width: 27, depth: 26 },
  { x: 269, z: -121, width: 26, depth: 25 },
].map(plot => Object.freeze(plot)));

export function createRandom(seed = 2026) {
  if (!Number.isInteger(seed) || !Number.isFinite(seed)) throw new TypeError('World seed must be a finite integer');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function coastRadiusAt(angle) {
  return 549 + 19 * Math.sin(3 * angle + 0.8) + 12 * Math.sin(7 * angle - 0.4);
}

function hash(x, z) {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function terrainNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smoothstep(0, 1, x - ix);
  const fz = smoothstep(0, 1, z - iz);
  const a = hash(ix, iz) * (1 - fx) + hash(ix + 1, iz) * fx;
  const b = hash(ix, iz + 1) * (1 - fx) + hash(ix + 1, iz + 1) * fx;
  return a * (1 - fz) + b * fz;
}

export function roadProjection(x, z, road) {
  const dx = road.b.x - road.a.x;
  const dz = road.b.z - road.a.z;
  const t = clamp01(((x - road.a.x) * dx + (z - road.a.z) * dz) / (road.length * road.length));
  return { t, distance: Math.hypot(x - road.a.x - dx * t, z - road.a.z - dz * t) };
}

export function distanceToRoad(x, z) {
  let distance = Infinity;
  for (const road of ROADS) distance = Math.min(distance, roadProjection(x, z, road).distance);
  return distance;
}

function validatePosition(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('Terrain coordinates must be finite numbers');
}

const hills = [
  [-240, -390, 55, 102], [255, 285, 76, 108], [-385, 310, 46, 85],
  [145, -360, 38, 112], [-85, 130, 24, 95],
];

// Physical ground beneath bridges, used to render riverbeds without filling their arches.
export function terrainHeightAt(x, z) {
  validatePosition(x, z);
  const radius = Math.hypot(x, z);
  const inland = coastRadiusAt(Math.atan2(z, x)) - radius;
  if (inland <= 0) {
    const seabed = -0.35 - Math.min(33, -inland * 0.19);
    const bank = smoothstep(10, 29, Math.abs(z - riverCenterAt(x)));
    return Math.min(seabed, -3.7) * (1 - bank) + seabed * bank;
  }
  const coastal = smoothstep(0, 75, inland);
  let height = 5 + terrainNoise(x / 125, z / 125) * 12 + terrainNoise(x / 38, z / 38) * 2;
  for (const [hx, hz, amplitude, spread] of hills) {
    height += amplitude * Math.exp(-((x - hx) ** 2 + (z - hz) ** 2) / (spread * spread));
  }
  height = -0.35 + smoothstep(0, 24, inland) * 3.1 + coastal * height;
  for (const location of LOCATIONS) {
    const distance = Math.hypot(x - location.x, z - location.z);
    const weight = 1 - smoothstep(location.radius - 12, location.radius + 24, distance);
    height += (location.elevation - height) * weight * coastal;
  }
  const riverDistance = Math.abs(z - riverCenterAt(x));
  const bank = smoothstep(10, 29, riverDistance);
  height = -3.7 * (1 - bank) + height * bank;

  // The nearest road owns its entire cross-section. Avoid order-dependent blending at junctions.
  let nearest = null;
  let nearestDistance = 8;
  let nearestT = 0;
  for (const road of ROADS) {
    if (road.bridge) continue;
    const projection = roadProjection(x, z, road);
    if (projection.distance >= nearestDistance) continue;
    nearestDistance = projection.distance;
    nearestT = projection.t;
    nearest = road;
  }
  if (nearest) {
    const along = nearestT * nearest.length;
    const slope = smoothstep(nearest.a.flat, nearest.length - nearest.b.flat, along);
    const roadHeight = nearest.a.height + (nearest.b.height - nearest.a.height) * slope;
    height += (roadHeight - height) * (1 - smoothstep(5.5, 8, nearestDistance)) * coastal;
  }
  return height;
}

// Contract height is the walkable surface: bridge decks are ground for main's character controller.
export function heightAt(x, z) {
  validatePosition(x, z);
  for (const bridge of BRIDGES) {
    if (Math.abs(x - bridge.x) <= bridge.width / 2 && Math.abs(z - bridge.z) <= bridge.length / 2) {
      return bridge.height;
    }
  }
  return terrainHeightAt(x, z);
}
