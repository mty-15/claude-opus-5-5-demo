import { rayBoxDistance } from './rules.js';

export const PLAYER_RADIUS = 0.36;
export const WORLD_LIMIT = 670;
const PLAYER_HEIGHT = 1.75;
const CELL = 24;
const STEP_HEIGHT = 0.65;
const MOVE_STEP = 0.25;
const CONTACT_EPSILON = 1e-7;
const TERRAIN_RAY_STEP = 1;
const RAY_REFINEMENTS = 12;
const DIRECTION_TOLERANCE = 1e-6;
const AXES = ['X', 'Y', 'Z'];

function finite(...values) {
  if (!values.every(Number.isFinite)) throw new TypeError('Collision inputs must be finite numbers');
}

function vector(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('Collision vector must be an object');
  finite(value.x, value.y, value.z);
}

function body(radius, height) {
  finite(radius, height);
  if (radius <= 0 || height <= 0) throw new RangeError('Collision radius and height must be positive');
}

function rayInputs(origin, direction, maxDistance, allowInfinity = false) {
  vector(origin);
  vector(direction);
  if (Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) > DIRECTION_TOLERANCE) {
    throw new RangeError('Ray direction must be normalized');
  }
  if (!allowInfinity || maxDistance !== Infinity) finite(maxDistance);
  if (maxDistance < 0) throw new RangeError('Ray distance must be non-negative');
}

// Exact circle/AABB footprint test shared by walls, floors and ceilings. Tangency is not penetration.
function overlaps(x, z, radius, box) {
  const nx = Math.max(box.minX, Math.min(x, box.maxX));
  const nz = Math.max(box.minZ, Math.min(z, box.maxZ));
  return (x - nx) ** 2 + (z - nz) ** 2 < radius * radius;
}

// The same broad phase serves walking, driving, vertical sweeps and projectile obstruction.
export class CollisionWorld {
  constructor(boxes, heightAt) {
    if (!Array.isArray(boxes)) throw new TypeError('Collision boxes must be an array');
    if (typeof heightAt !== 'function') throw new TypeError('Collision terrain must be a heightAt function');
    this.heightAt = heightAt;
    this.cells = new Map();
    for (const box of boxes) {
      if (box === null || typeof box !== 'object') throw new TypeError('Collision box must be an object');
      for (const axis of AXES) {
        finite(box[`min${axis}`], box[`max${axis}`]);
        if (box[`min${axis}`] > box[`max${axis}`]) throw new RangeError('Collision box bounds are inverted');
      }
      // Snapshot the bounds so external mutation cannot invalidate the spatial index.
      const bounds = Object.freeze({ ...box });
      for (let x = Math.floor(bounds.minX / CELL); x <= Math.floor(bounds.maxX / CELL); x++) {
        for (let z = Math.floor(bounds.minZ / CELL); z <= Math.floor(bounds.maxZ / CELL); z++) {
          const key = `${x},${z}`;
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(bounds);
        }
      }
    }
  }

  query(minX, minZ, maxX, maxZ) {
    finite(minX, minZ, maxX, maxZ);
    if (minX > maxX || minZ > maxZ) throw new RangeError('Collision query bounds are inverted');
    const result = new Set();
    for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++) {
      for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++) {
        const boxes = this.cells.get(`${x},${z}`);
        if (boxes) for (const box of boxes) result.add(box);
      }
    }
    return result;
  }

  groundAt(x, z) {
    const ground = this.heightAt(x, z);
    finite(ground);
    return ground;
  }

  // Optional radius preserves the existing vehicle/custom-radius move API.
  // Terrain is the physical lower bound even when ceilingY is below ground; solid tops obey the cap.
  floorAt(x, z, ceilingY, radius = PLAYER_RADIUS) {
    finite(x, z, ceilingY);
    body(radius, PLAYER_HEIGHT);
    let floor = this.groundAt(x, z);
    for (const box of this.query(x - radius, z - radius, x + radius, z + radius)) {
      if (box.maxY > ceilingY || box.maxY <= floor || !overlaps(x, z, radius, box)) continue;
      floor = box.maxY;
    }
    return floor;
  }

  blocked(x, y, z, radius = PLAYER_RADIUS, height = PLAYER_HEIGHT) {
    finite(x, y, z);
    body(radius, height);
    for (const box of this.query(x - radius, z - radius, x + radius, z + radius)) {
      if (y + height <= box.minY || y >= box.maxY) continue;
      if (overlaps(x, z, radius, box)) return true;
    }
    return false;
  }

  move(position, dx, dz, radius = PLAYER_RADIUS, height = PLAYER_HEIGHT) {
    vector(position);
    finite(dx, dz);
    body(radius, height);
    let { x, z } = position;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / MOVE_STEP));
    finite(steps);
    const sx = dx / steps;
    const sz = dz / steps;
    // Keep the step cap relative to this frame's original feet, never ratchet up a wall per substep.
    const ceilingY = position.y + STEP_HEIGHT;
    const canMove = (nx, nz) => {
      const floor = this.floorAt(nx, nz, ceilingY, radius);
      return floor <= ceilingY && !this.blocked(nx, Math.max(position.y, floor), nz, radius, height);
    };
    for (let i = 0; i < steps; i++) {
      const nx = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, x + sx));
      if (canMove(nx, z)) x = nx;
      const nz = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, z + sz));
      if (canMove(x, nz)) z = nz;
    }
    // This method stays horizontal. Main resolves an accepted step with floorAt before vertical().
    return { x, z };
  }

  // velocityY already includes main's gravity; y is feet and impactSpeed is positive on landing only.
  vertical(position, velocityY, dt, height = PLAYER_HEIGHT) {
    vector(position);
    finite(velocityY, dt);
    body(PLAYER_RADIUS, height);
    if (dt < 0) throw new RangeError('Collision dt must be non-negative');
    const { x, y, z } = position;
    const nextY = y + velocityY * dt;
    finite(nextY, y + height, nextY + height);
    if (velocityY <= 0) {
      // Sweep from the starting feet, so a fast fall cannot skip an intermediate roof/platform.
      const floor = this.floorAt(x, z, y + CONTACT_EPSILON);
      if (nextY <= floor + CONTACT_EPSILON) {
        return { y: floor, vy: 0, grounded: true, impactSpeed: dt > 0 ? Math.max(0, -velocityY) : 0 };
      }
      return { y: nextY, vy: velocityY, grounded: false, impactSpeed: 0 };
    }

    let ceiling = Infinity;
    const head = y + height;
    const nextHead = nextY + height;
    for (const box of this.query(x - PLAYER_RADIUS, z - PLAYER_RADIUS, x + PLAYER_RADIUS, z + PLAYER_RADIUS)) {
      if (box.minY < head - CONTACT_EPSILON || box.minY > nextHead || !overlaps(x, z, PLAYER_RADIUS, box)) continue;
      ceiling = Math.min(ceiling, box.minY);
    }
    if (ceiling !== Infinity) return { y: ceiling - height, vy: 0, grounded: false, impactSpeed: 0 };
    return { y: nextY, vy: velocityY, grounded: false, impactSpeed: 0 };
  }

  ray(origin, direction, maxDistance) {
    // A spatial-grid ray requires a finite range; callers already supply weapon/camera travel limits.
    rayInputs(origin, direction, maxDistance);
    const endX = origin.x + direction.x * maxDistance;
    const endZ = origin.z + direction.z * maxDistance;
    finite(endX, endZ, origin.y + direction.y * maxDistance);
    let closest = maxDistance;
    for (const box of this.query(Math.min(origin.x, endX), Math.min(origin.z, endZ), Math.max(origin.x, endX), Math.max(origin.z, endZ))) {
      const hit = rayBoxDistance(origin, direction, box, closest);
      if (hit !== null) closest = Math.min(closest, hit);
    }
    const aboveGround = t => origin.y + direction.y * t - this.groundAt(origin.x + direction.x * t, origin.z + direction.z * t);
    if (aboveGround(0) <= 0) return 0;
    // A sampled heightfield cannot resolve arbitrarily narrow features. Include short rays and endpoints,
    // then refine the first sampled crossing rather than returning a point already inside a hill.
    let previous = 0;
    while (previous < closest) {
      const next = Math.min(previous + TERRAIN_RAY_STEP, closest);
      if (aboveGround(next) <= 0) {
        let low = previous;
        let high = next;
        for (let i = 0; i < RAY_REFINEMENTS; i++) {
          const middle = (low + high) / 2;
          if (aboveGround(middle) > 0) low = middle;
          else high = middle;
        }
        return high;
      }
      previous = next;
    }
    return closest;
  }

  visible(a, b) {
    vector(a);
    vector(b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const distance = Math.hypot(dx, dy, dz);
    finite(distance);
    return distance < 0.001 || this.ray(a, { x: dx / distance, y: dy / distance, z: dz / distance }, distance) >= distance - 0.25;
  }
}

export function raySphereDistance(origin, direction, center, radius, maxDistance) {
  rayInputs(origin, direction, maxDistance, true);
  vector(center);
  finite(radius);
  if (radius < 0) throw new RangeError('Sphere radius must be non-negative');
  const x = origin.x - center.x;
  const y = origin.y - center.y;
  const z = origin.z - center.z;
  const b = x * direction.x + y * direction.y + z * direction.z;
  const c = x * x + y * y + z * z - radius * radius;
  finite(b, c);
  // Starting in/on a sphere is a zero-distance hit, regardless of the ray's direction.
  if (c <= 0) return 0;
  const discriminant = b * b - c;
  finite(discriminant);
  if (discriminant < 0) return null;
  const distance = -b - Math.sqrt(discriminant);
  return distance >= 0 && distance <= maxDistance ? distance : null;
}
