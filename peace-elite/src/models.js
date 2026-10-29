import * as THREE from 'three';

const TAU = Math.PI * 2;
const WEAPON_IDS = ['m416', 'akm', 'ump45', 'kar98'];
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}
function weaponId(id) {
  if (!WEAPON_IDS.includes(id)) throw new RangeError(`Unknown weapon: ${id}`);
  return id;
}
// Sharing is confined to one asset. Disposing one actor never invalidates another.
// Object3D-only factories expose this idempotent disposer via userData.dispose.
function asset(name) {
  const root = new THREE.Group();
  root.name = name;
  const geometries = new Map();
  const materials = new Set();
  let disposed = false;
  const material = (color, options = {}) => {
    const result = new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...options });
    materials.add(result);
    return result;
  };
  const geometry = (key, make) => {
    if (!geometries.has(key)) geometries.set(key, make());
    return geometries.get(key);
  };
  const mesh = (parent, shape, surface, position = [0, 0, 0], rotation) => {
    const result = new THREE.Mesh(shape, surface);
    result.position.set(...position);
    if (rotation) result.rotation.set(...rotation);
    result.castShadow = true;
    result.receiveShadow = true;
    parent.add(result);
    return result;
  };
  const box = (parent, size, surface, position, rotation) => mesh(parent,
    geometry(`box:${size}`, () => new THREE.BoxGeometry(...size)), surface, position, rotation);
  const cylinder = (parent, top, bottom, height, surface, position, rotation, segments = 10) => mesh(parent,
    geometry(`cylinder:${top}:${bottom}:${height}:${segments}`,
      () => new THREE.CylinderGeometry(top, bottom, height, segments)), surface, position, rotation);
  const sphere = (parent, radius, surface, position, scale = [1, 1, 1]) => {
    const result = mesh(parent, geometry(`sphere:${radius}`,
      () => new THREE.SphereGeometry(radius, 12, 8)), surface, position);
    result.scale.set(...scale);
    return result;
  };
  const bar = (parent, from, to, radius, surface, segments = 6) => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const result = cylinder(parent, radius, radius, 1, surface, undefined, undefined, segments);
    result.position.copy(start).add(end).multiplyScalar(0.5);
    result.scale.y = start.distanceTo(end);
    result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    return result;
  };
  const slab = (parent, points, thickness, surface, position = [0, 0, 0]) => {
    const shape = new THREE.Shape();
    points.forEach(([x, z], i) => i ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
    shape.closePath();
    return mesh(parent, geometry(`slab:${JSON.stringify(points)}:${thickness}`, () => {
      const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -thickness / 2, 0);
      return geo;
    }), surface, position);
  };
  // Bake only rigid regions; each supplied pivot remains independently animated.
  // AI uses vertex colour instead of one draw call per tiny fabric/metal detail.
  const mergeRigid = pivots => {
    root.updateMatrixWorld(true);
    const boundaries = new Set(pivots);
    const surfaces = new Map();
    const matrix = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    const vertex = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let batchId = 0;
    for (const pivot of pivots) {
      const batches = new Map();
      const inverse = pivot.matrixWorld.clone().invert();
      const collect = parent => {
        for (const child of parent.children) {
          if (boundaries.has(child)) continue;
          if (child.isMesh) {
            const source = child.material;
            const family = source.transparent ? `glass:${source.uuid}` : source.metalness > 0 ? 'metal' : 'fabric';
            const key = `${family}:${source.side}`;
            if (!surfaces.has(key)) {
              surfaces.set(key, material(0xffffff, {
                vertexColors: true,
                side: source.side,
                metalness: family === 'metal' ? 0.65 : source.transparent ? source.metalness : 0,
                roughness: family === 'metal' ? 0.4 : source.transparent ? source.roughness : 0.85,
                transparent: source.transparent,
                opacity: source.opacity,
                depthWrite: source.depthWrite,
              }));
            }
            if (!batches.has(key)) batches.set(key, []);
            batches.get(key).push(child);
          }
          collect(child);
        }
      };
      collect(pivot);
      for (const [key, pieces] of batches) {
        let vertexCount = 0, indexCount = 0;
        for (const piece of pieces) {
          const shape = piece.geometry;
          vertexCount += shape.attributes.position.count;
          indexCount += shape.index ? shape.index.count : shape.attributes.position.count;
        }
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const colors = new Float32Array(vertexCount * 3);
        const indices = new (vertexCount > 65535 ? Uint32Array : Uint16Array)(indexCount);
        let offset = 0, indexOffset = 0;
        for (const piece of pieces) {
          const shape = piece.geometry;
          const count = shape.attributes.position.count;
          const color = piece.material.color;
          matrix.multiplyMatrices(inverse, piece.matrixWorld);
          normalMatrix.getNormalMatrix(matrix);
          for (let i = 0; i < count; i++) {
            vertex.fromBufferAttribute(shape.attributes.position, i).applyMatrix4(matrix);
            normal.fromBufferAttribute(shape.attributes.normal, i).applyNormalMatrix(normalMatrix);
            const n = (offset + i) * 3;
            vertex.toArray(positions, n);
            normal.toArray(normals, n);
            colors[n] = color.r; colors[n + 1] = color.g; colors[n + 2] = color.b;
          }
          const countIndices = shape.index ? shape.index.count : count;
          for (let i = 0; i < countIndices; i++) indices[indexOffset++] = offset + (shape.index ? shape.index.getX(i) : i);
          offset += count;
          piece.removeFromParent();
        }
        const shape = geometry(`rigid-batch:${batchId++}`, () => {
          const result = new THREE.BufferGeometry();
          result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          result.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
          result.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          result.setIndex(new THREE.BufferAttribute(indices, 1));
          result.computeBoundingBox();
          result.computeBoundingSphere();
          return result;
        });
        mesh(pivot, shape, surfaces.get(key)).name = `${pivot.name}-${key.split(':')[0]}-batch`;
      }
    }
    // Prune only after every region is baked: original primitives were shared
    // inside this actor, so freeing them during the first region would be wrong.
    const liveGeometry = new Set(), liveMaterial = new Set();
    root.traverse(object => {
      if (!object.isMesh) return;
      liveGeometry.add(object.geometry);
      liveMaterial.add(object.material);
    });
    for (const [key, value] of geometries) if (!liveGeometry.has(value)) { value.dispose(); geometries.delete(key); }
    for (const value of materials) if (!liveMaterial.has(value)) { value.dispose(); materials.delete(value); }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    geometries.forEach(value => value.dispose());
    materials.forEach(value => value.dispose());
    geometries.clear();
    materials.clear();
  };
  const assertLive = () => { if (disposed) throw new Error(`${name} has been disposed`); };
  root.userData.dispose = dispose;
  return { root, material, geometry, mesh, box, cylinder, sphere, bar, slab, mergeRigid, dispose, assertLive };
}
function group(parent, name, position = [0, 0, 0]) {
  const result = new THREE.Group();
  result.name = name;
  result.position.set(...position);
  parent.add(result);
  return result;
}
function palette(a, color = 0x647466) {
  return {
    cloth: a.material(color), darkCloth: a.material(new THREE.Color(color).multiplyScalar(0.58)),
    webbing: a.material(0x777459), armor: a.material(0x343c34, { roughness: 0.93 }),
    rubber: a.material(0x202421, { roughness: 0.98 }),
    metal: a.material(0x343b3d, { metalness: 0.72, roughness: 0.36 }),
    steel: a.material(0x858f92, { metalness: 0.8, roughness: 0.28 }), tan: a.material(0xb3a079),
    wood: a.material(0x845033, { roughness: 0.56 }), skin: a.material(0xc39472),
    glass: a.material(0x24494e, { metalness: 0.5, roughness: 0.15 }),
    light: a.material(0xe9dcb0, { emissive: 0xb99a46, emissiveIntensity: 0.3 }), red: a.material(0xd2513f),
  };
}
const GUN_SPEC = {
  m416: { barrel: -0.66, stock: 0.28, sight: 0.13, color: 0x90c477 },
  akm: { barrel: -0.70, stock: 0.30, sight: 0.085, color: 0xe4b565 },
  ump45: { barrel: -0.43, stock: 0.24, sight: 0.12, color: 0x7da9d3 },
  kar98: { barrel: -0.88, stock: 0.32, sight: 0.15, color: 0xd3a575 },
};
function rifle(a, parent, id, p, detailed = true) {
  weaponId(id);
  const root = group(parent, id);
  const spec = GUN_SPEC[id];
  const sniper = id === 'kar98', ak = id === 'akm', ump = id === 'ump45';
  const furniture = ak || sniper ? p.wood : ump ? p.rubber : p.tan;
  const barrel = (radius, length, z, surface = p.metal) => a.cylinder(root, radius, radius,
    length, surface, [0, 0.025, z], [Math.PI / 2, 0, 0], detailed ? 12 : 8);
  a.box(root, [ump ? 0.073 : 0.067, sniper ? 0.058 : 0.092, ump ? 0.28 : 0.32], p.metal, [0, 0.005, -0.08]);
  a.box(root, [0.055, 0.13, 0.066], p.rubber, [0, -0.091, 0.017], [-0.25, 0, 0]);
  a.box(root, [0.022, 0.014, 0.075], p.metal, [0, -0.105, -0.05]);
  a.box(root, [0.022, 0.064, 0.014], p.metal, [0, -0.077, -0.081]);
  a.box(root, [0.008, 0.033, 0.012], p.steel, [0, -0.064, -0.03], [-0.25, 0, 0]);
  barrel(0.017, Math.abs(spec.barrel + 0.24), (spec.barrel - 0.24) / 2);
  barrel(0.024, 0.055, spec.barrel);
  a.cylinder(root, 0.011, 0.011, 0.002, p.rubber,
    [0, 0.025, spec.barrel - 0.029], [Math.PI / 2, 0, 0]).name = 'muzzle';
  if (ump) {
    a.box(root, [0.081, 0.106, 0.22], furniture, [0, 0.007, -0.237]);
    a.bar(root, [0, 0.025, 0.075], [0, 0.016, spec.stock], 0.014, p.metal);
    a.bar(root, [0, -0.055, 0.068], [0, -0.075, spec.stock], 0.014, p.metal);
    a.box(root, [0.067, 0.13, 0.036], p.rubber, [0, -0.035, spec.stock]);
  } else {
    a.box(root, [0.073, 0.104, sniper ? 0.35 : 0.235], furniture,
      [0, sniper ? -0.025 : 0.005, sniper ? -0.30 : -0.29]);
    a.box(root, [0.052, 0.065, 0.13], furniture, [0, -0.008, 0.117], [-0.1, 0, 0]);
    a.box(root, [0.077, 0.135, 0.19], furniture, [0, -0.018, spec.stock - 0.04], [0.14, 0, 0]);
    a.box(root, [0.083, 0.15, 0.025], p.rubber, [0, -0.035, spec.stock + 0.051], [0.14, 0, 0]);
  }
  const magazine = group(root, 'magazine', [0, -0.061, -0.133]);
  if (ak) {
    a.box(magazine, [0.049, 0.09, 0.079], p.metal, [0, -0.035, 0], [-0.06, 0, 0]);
    a.box(magazine, [0.049, 0.087, 0.077], p.metal, [0, -0.112, 0.015], [-0.3, 0, 0]);
    a.box(magazine, [0.051, 0.068, 0.08], p.metal, [0, -0.173, 0.044], [-0.55, 0, 0]);
  } else if (!sniper) {
    a.box(magazine, [0.045, ump ? 0.22 : 0.17, ump ? 0.052 : 0.078], ump ? p.rubber : p.metal,
      [0, ump ? -0.105 : -0.074, 0.012], [-0.12, 0, 0]);
    a.box(magazine, [0.052, 0.018, ump ? 0.059 : 0.085], p.rubber,
      [0, ump ? -0.217 : -0.16, 0.025], [-0.12, 0, 0]);
  } else a.box(magazine, [0.052, 0.027, 0.15], p.metal, [0, 0.008, 0.03]);
  const bolt = group(root, 'bolt', [0.041, 0.027, 0.035]);
  a.bar(bolt, [0, 0, 0], [0.047, -0.016, 0], 0.008, p.steel);
  if (sniper) {
    a.sphere(bolt, 0.015, p.metal, [0.05, -0.021, 0]);
    for (const z of [-0.13, 0.015]) a.box(root, [0.043, 0.062, 0.022], p.metal, [0, 0.09, z]);
    a.mesh(root, a.geometry('scope-tube', () => new THREE.CylinderGeometry(0.029, 0.029, 0.25, 12, 1, true)),
      p.metal, [0, spec.sight, -0.078], [Math.PI / 2, 0, 0]);
    const scopeGlass = a.material(0x7aabb1, { transparent: true, opacity: 0.11, roughness: 0.1, depthWrite: false });
    for (const z of [-0.22, 0.065]) {
      a.mesh(root, a.geometry('scope-bell', () => new THREE.CylinderGeometry(0.045, 0.04, 0.06, 12, 1, true)),
        p.rubber, [0, spec.sight, z], [Math.PI / 2, 0, 0]);
      a.mesh(root, a.geometry('scope-rim', () => new THREE.TorusGeometry(0.040, 0.005, 5, 16)),
        p.rubber, [0, spec.sight, z + (z > 0 ? 0.03 : -0.03)]);
      a.cylinder(root, 0.036, 0.036, 0.002, scopeGlass,
        [0, spec.sight, z + (z > 0 ? 0.031 : -0.031)], [Math.PI / 2, 0, 0]);
    }
    a.cylinder(root, 0.022, 0.022, 0.033, p.metal, [0, 0.19, -0.07]);
  } else if (!ak) {
    a.box(root, [0.044, 0.018, 0.28], p.metal, [0, 0.067, -0.13]);
    const optic = group(root, 'reflex-sight', [0, spec.sight, -0.055]);
    a.box(optic, [0.072, 0.016, 0.053], p.metal, [0, -0.028, 0]);
    for (const x of [-0.029, 0.029]) a.box(optic, [0.012, 0.061, 0.048], p.metal, [x, 0.005, 0]);
    a.box(optic, [0.07, 0.012, 0.048], p.metal, [0, 0.038, 0]);
    if (detailed) {
      const lens = a.material(0x75bab6, { transparent: true, opacity: 0.18, roughness: 0.12, depthWrite: false });
      a.box(optic, [0.047, 0.047, 0.003], lens, [0, 0.003, -0.01]);
      const dot = a.material(0xff5538, { emissive: 0xff3218, emissiveIntensity: 3, toneMapped: false });
      a.sphere(optic, 0.0021, dot, [0, 0, 0.006]);
    }
  } else {
    a.box(root, [0.049, 0.025, 0.026], p.metal, [0, 0.061, 0.023]);
    for (const x of [-0.017, 0.017]) a.box(root, [0.008, 0.03, 0.015], p.metal, [x, 0.081, 0.026]);
    a.box(root, [0.012, 0.069, 0.021], p.metal, [0, 0.067, -0.58]);
    barrel(0.023, 0.024, -0.57);
    a.cylinder(root, 0.011, 0.011, 0.26, p.metal, [0, 0.07, -0.34], [Math.PI / 2, 0, 0]);
  }
  if (detailed) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < (ump ? 4 : 6); i++) a.box(root, [0.003, 0.012, 0.02], p.rubber,
        [side * 0.041, 0.026, -0.22 - i * 0.022]);
      for (const z of [-0.12, 0.02]) a.cylinder(root, 0.006, 0.006, 0.003, p.steel,
        [side * 0.036, 0.011, z], [0, 0, Math.PI / 2], 6);
    }
    if (!ak && !sniper) for (let i = 0; i < 10; i++) a.box(root, [0.047, 0.009, 0.009], p.rubber,
      [0, 0.078, -0.25 + i * 0.027]);
    a.box(root, [0.003, 0.027, 0.08], p.rubber, [0.035, 0.023, -0.037]);
    a.box(root, [0.003, 0.01, 0.035], p.steel, [-0.036, 0.018, -0.05]);
  }
  return { root, magazine, bolt, spec };
}
function canopy(a, parent, p) {
  const root = group(parent, 'parachute');
  const colors = [0xc8b88b, 0x657b57, 0xc8b88b, 0xdd8952, 0xd3c79e, 0xd3c79e, 0xdd8952, 0xc8b88b, 0x657b57, 0xc8b88b];
  const surfaces = new Map();
  const point = (u, v) => [Math.sin(u) * 2.65, 3.42 + Math.cos(u) * 1.22 + Math.cos(v * Math.PI / 2) * 0.2,
    v * (1.18 + Math.cos(u) * 0.2)];
  for (let strip = 0; strip < 10; strip++) {
    const positions = [], indices = [];
    for (let u = 0; u <= 2; u++) {
      const angle = -Math.PI / 2 + (strip + u / 2) / 10 * Math.PI;
      for (let v = 0; v <= 6; v++) positions.push(...point(angle, v / 3 - 1));
    }
    for (let u = 0; u < 2; u++) for (let v = 0; v < 6; v++) {
      const n = u * 7 + v;
      indices.push(n, n + 7, n + 1, n + 1, n + 7, n + 8);
    }
    if (!surfaces.has(colors[strip])) surfaces.set(colors[strip], a.material(colors[strip], { side: THREE.DoubleSide }));
    a.mesh(root, a.geometry(`canopy:${strip}`, () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }), surfaces.get(colors[strip]));
  }
  const cord = a.material(0xe7ddbe);
  for (let rib = 0; rib <= 10; rib += 2) {
    const angle = -Math.PI / 2 + rib / 10 * Math.PI;
    for (const side of [-1, 1]) {
      const edge = point(angle, side);
      a.bar(root, [Math.sign(edge[0]) * 0.22, 1.25, side * 0.09], edge, 0.008, cord);
    }
  }
  for (const side of [-1, 1]) a.bar(root, [side * 0.17, 1.03, 0.08], [side * 0.25, 1.59, 0.08], 0.021, p.webbing);
  root.visible = false;
  return root;
}

/** Jointed 1.75 m actor. Root origin is the soles; yaw zero faces -Z. */
export function createSoldier({ color = 0x647466, player = false } = {}) {
  const a = asset('soldier');
  const p = palette(a, color);
  // Broad cloth panels and a few warm accents stay legible without textures.
  p.cloth.color.lerp(new THREE.Color(0xbac5b6), 0.16);
  p.armor.color.set(0x303c40);
  p.webbing.color.set(0xa18e70);
  const panel = a.material(new THREE.Color(color).lerp(new THREE.Color(0xc6cbbd), 0.38));
  const accent = a.material(player ? 0xc58d54 : 0xad9774);
  const seam = a.material(0x455051);
  // Octagonal cross-sections provide tailored shoulders/waist, not stacked cubes.
  // Rings are [height, width, depth, optional forward/back offset], low to high.
  const tailored = (parent, rings, surface, position = [0, 0, 0], rotation) => {
    const shape = a.geometry('tailored:' + JSON.stringify(rings), () => {
      const vertices = [], indices = [];
      for (const [y, width, depth, z = 0] of rings) {
        const x = width / 2, d = depth / 2, bevel = Math.min(width, depth) * 0.19;
        for (const [px, pz] of [[-x + bevel, -d], [x - bevel, -d], [x, -d + bevel],
          [x, d - bevel], [x - bevel, d], [-x + bevel, d], [-x, d - bevel], [-x, -d + bevel]]) vertices.push(px, y, pz + z);
      }
      for (let ring = 0; ring < rings.length - 1; ring++) for (let j = 0; j < 8; j++) {
        const lo = ring * 8 + j, next = ring * 8 + (j + 1) % 8;
        indices.push(lo, lo + 8, next, next, lo + 8, next + 8);
      }
      const top = (rings.length - 1) * 8;
      for (let j = 1; j < 7; j++) indices.push(0, j, j + 1, top, top + j + 1, top + j);
      const indexed = new THREE.BufferGeometry();
      indexed.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      indexed.setIndex(indices);
      const result = indexed.toNonIndexed();
      indexed.dispose();
      result.computeVertexNormals();
      return result;
    });
    return a.mesh(parent, shape, surface, position, rotation);
  };
  const softBox = (parent, size, surface, position, rotation) => {
    const [w, h, d] = size, edge = Math.min(w, h, d) * 0.17;
    // Thin straps/trim need clipped corners, not four rings of bevels.
    if (Math.min(w, h, d) <= 0.035) return tailored(parent,
      [[-h / 2, w, d], [h / 2, w, d]], surface, position, rotation);
    return tailored(parent, [[-h / 2, w - edge * 2, d - edge * 2],
      [-h / 2 + edge, w, d], [h / 2 - edge, w, d],
      [h / 2, w - edge * 2, d - edge * 2]], surface, position, rotation);
  };
  const hips = group(a.root, 'hips', [0, 0.9, 0]);
  const torso = group(hips, 'torso');
  tailored(hips, [[-0.095, 0.29, 0.20], [-0.015, 0.335, 0.232], [0.095, 0.30, 0.21]], p.darkCloth);
  softBox(hips, [0.342, 0.043, 0.238], p.rubber, [0, 0.077, 0]);
  softBox(hips, [0.048, 0.031, 0.021], p.tan, [0, 0.077, -0.128]);
  tailored(torso, [[0.095, 0.295, 0.21], [0.23, 0.335, 0.235],
    [0.395, 0.408, 0.248], [0.462, 0.414, 0.23], [0.522, 0.185, 0.18]], p.cloth);
  // Shaped plate carrier; clipped corners expose the shoulder line underneath.
  tailored(torso, [[0.16, 0.275, 0.045], [0.32, 0.326, 0.056],
    [0.431, 0.29, 0.052], [0.466, 0.19, 0.035]], p.armor, [0, 0, -0.137]);
  tailored(torso, [[0.17, 0.27, 0.035], [0.405, 0.31, 0.041],
    [0.468, 0.20, 0.03]], p.armor, [0, 0, 0.133]);
  softBox(torso, [0.212, 0.14, 0.017], panel, [0, 0.352, -0.176]);
  softBox(torso, [0.092, 0.029, 0.012], seam, [0, 0.39, -0.19]);
  a.box(torso, [0.051, 0.005, 0.003], p.tan, [0, 0.39, -0.197]);
  for (const side of [-1, 1]) {
    softBox(torso, [0.044, 0.29, 0.025], p.webbing, [side * 0.128, 0.351, -0.16], [0, 0, -side * 0.11]);
    softBox(torso, [0.051, 0.036, 0.245], panel, [side * 0.13, 0.472, 0]);
    softBox(torso, [0.089, 0.116, 0.058], p.darkCloth, [side * 0.068, 0.23, -0.178]);
    softBox(torso, [0.089, 0.027, 0.060], p.webbing, [side * 0.068, 0.273, -0.181]);
    a.box(torso, [0.018, 0.043, 0.007], seam, [side * 0.068, 0.249, -0.213]);
    softBox(hips, [0.073, 0.125, 0.091], p.darkCloth, [side * 0.194, -0.029, 0.018]);
  }
  for (let row = 0; row < 2; row++) a.box(torso, [0.174, 0.009, 0.006], p.webbing, [0, 0.328 + row * 0.027, -0.188]);
  softBox(torso, [0.050, 0.077, 0.033], seam, [-0.163, 0.365, -0.137]);
  a.box(torso, [0.025, 0.019, 0.008], p.tan, [-0.163, 0.378, -0.157]);
  a.bar(torso, [-0.166, 0.399, -0.139], [-0.171, 0.46, -0.132], 0.004, p.rubber, 4);
  // A compact hiking-style pack replaces the large square slab on the back.
  const pack = group(torso, 'backpack', [0, 0.285, 0.218]);
  tailored(pack, [[-0.176, 0.205, 0.115], [-0.135, 0.262, 0.17],
    [0.105, 0.278, 0.178], [0.185, 0.23, 0.142]], p.darkCloth);
  softBox(pack, [0.262, 0.081, 0.167], panel, [0, 0.142, 0.011]);
  softBox(pack, [0.211, 0.143, 0.058], p.cloth, [0, -0.056, 0.101]);
  for (const x of [-0.084, 0.084]) {
    softBox(pack, [0.022, 0.289, 0.012], p.webbing, [x, 0.012, 0.097]);
    softBox(pack, [0.031, 0.03, 0.018], seam, [x, 0.044, 0.109]);
  }
  a.bar(pack, [-0.053, 0.181, 0], [-0.037, 0.211, 0], 0.012, p.webbing);
  a.bar(pack, [-0.037, 0.211, 0], [0.037, 0.211, 0], 0.012, p.webbing);
  a.bar(pack, [0.037, 0.211, 0], [0.053, 0.181, 0], 0.012, p.webbing);
  softBox(pack, [0.055, 0.177, 0.091], p.webbing, [-0.162, -0.023, 0.022]);
  softBox(pack, [0.052, 0.123, 0.074], p.cloth, [0.155, -0.017, 0.022]);
  softBox(pack, [0.070, 0.024, 0.008], accent, [0, -0.031, 0.133]);
  a.cylinder(torso, 0.053, 0.065, 0.11, p.skin, [0, 0.545, 0], undefined, 8);
  tailored(torso, [[0.487, 0.191, 0.197], [0.519, 0.173, 0.187],
    [0.57, 0.139, 0.143]], accent, [0, 0, -0.005]);
  softBox(torso, [0.064, 0.064, 0.029], accent, [0.052, 0.498, -0.1], [0, 0, -0.22]);
  const head = group(torso, 'head', [0, 0.665, -0.005]);
  tailored(head, [[-0.106, 0.09, 0.095, -0.022], [-0.072, 0.148, 0.147, -0.014],
    [-0.005, 0.187, 0.182], [0.07, 0.174, 0.179], [0.114, 0.111, 0.123]], p.skin);
  softBox(head, [0.162, 0.039, 0.032], p.rubber, [0, 0.021, -0.083]);
  for (const side of [-1, 1]) {
    softBox(head, [0.061, 0.027, 0.014], p.glass, [side * 0.039, 0.022, -0.103]);
    a.box(head, [0.044, 0.004, 0.002], p.steel, [side * 0.039, 0.03, -0.111]);
    a.bar(head, [side * 0.081, 0.022, -0.076], [side * 0.097, 0.014, 0.034], 0.008, p.rubber, 4);
    a.cylinder(head, 0.031, 0.031, 0.028, p.rubber, [side * 0.106, -0.009, 0.02], [0, 0, Math.PI / 2], 8);
    a.bar(head, [side * 0.101, 0.017, 0.027], [side * 0.065, -0.09, -0.029], 0.009, p.webbing, 4);
  }
  tailored(head, [[-0.036, 0.025, 0.032], [0.012, 0.02, 0.018]], p.skin, [0, 0, -0.098]);
  a.box(head, [0.038, 0.005, 0.005], p.wood, [0, -0.069, -0.091]);
  const helmetGeo = a.geometry('scout-helmet', () => {
    const geo = new THREE.SphereGeometry(0.132, 12, 5, 0, TAU, 0, Math.PI * 0.55);
    const flat = geo.toNonIndexed(); geo.dispose(); flat.computeVertexNormals(); return flat;
  });
  a.mesh(head, helmetGeo, p.cloth, [0, 0.048, 0.007]).scale.set(0.96, 1, 1.07);
  softBox(head, [0.226, 0.019, 0.114], p.darkCloth, [0, 0.033, -0.071]);
  softBox(head, [0.033, 0.037, 0.027], seam, [0, 0.089, -0.119]);
  for (const side of [-1, 1]) {
    softBox(head, [0.018, 0.032, 0.084], p.webbing, [side * 0.123, 0.061, 0.01]);
    softBox(head, [0.012, 0.014, 0.043], seam, [side * 0.133, 0.061, 0.011]);
  }
  a.bar(head, [-0.112, -0.013, 0.015], [-0.057, -0.061, -0.117], 0.004, p.rubber, 4);
  const legs = [-1, 1].map(side => {
    const thigh = group(hips, side < 0 ? 'left-thigh' : 'right-thigh', [side * 0.102, 0, 0]);
    tailored(thigh, [[-0.385, 0.124, 0.133], [-0.25, 0.14, 0.151],
      [-0.12, 0.165, 0.177], [0.008, 0.156, 0.168]], p.cloth);
    softBox(thigh, [0.045, 0.155, 0.101], panel, [side * 0.071, -0.17, 0.02]);
    softBox(thigh, [0.063, 0.115, 0.065], p.darkCloth, [side * 0.07, -0.16, 0.028]);
    a.box(thigh, [0.035, 0.014, 0.005], p.webbing, [side * 0.07, -0.119, -0.008]);
    const shin = group(thigh, 'shin', [0, -0.4, 0]);
    tailored(shin, [[-0.36, 0.093, 0.108], [-0.175, 0.113, 0.131], [0.016, 0.128, 0.144]], p.cloth);
    softBox(shin, [0.098, 0.123, 0.043], p.armor, [0, -0.028, -0.076]);
    softBox(shin, [0.066, 0.075, 0.014], seam, [0, -0.025, -0.101]);
    a.box(shin, [0.127, 0.021, 0.12], p.webbing, [0, -0.047, 0]);
    const boot = group(shin, 'boot', [0, -0.4, 0]);
    tailored(boot, [[-0.024, 0.114, 0.135], [0.097, 0.111, 0.12]], p.rubber, [0, 0, 0.012]);
    softBox(boot, [0.13, 0.105, 0.233], p.rubber, [0, -0.038, -0.049]);
    softBox(boot, [0.139, 0.02, 0.251], seam, [0, -0.09, -0.052]);
    for (let i = 0; i < 3; i++) a.box(boot, [0.055, 0.006, 0.009], p.webbing, [0, 0.018 + i * 0.014, -0.098 + i * 0.026]);
    return { thigh, shin, boot };
  });
  const down = new THREE.Vector3(0, -1, 0);
  const direction = new THREE.Vector3(), target = new THREE.Vector3();
  const bend = new THREE.Vector3(), midpoint = new THREE.Vector3();
  const arms = [-1, 1].map(side => {
    const shoulder = new THREE.Vector3(side * 0.235, 0.475, 0);
    const upper = group(torso, side < 0 ? 'left-arm' : 'right-arm');
    const lower = group(torso, 'forearm');
    tailored(upper, [[-0.26, 0.11, 0.115], [-0.085, 0.146, 0.157],
      [-0.025, 0.142, 0.151], [0.016, 0.107, 0.12], [0.039, 0.066, 0.08]], p.cloth);
    softBox(upper, [0.029, 0.091, 0.096], panel, [side * 0.072, -0.065, 0]);
    a.box(upper, [0.005, 0.018, 0.056], accent, [side * 0.09, -0.061, 0]);
    tailored(lower, [[-0.26, 0.08, 0.092], [-0.17, 0.098, 0.109], [0.013, 0.116, 0.12]], p.darkCloth);
    softBox(lower, [0.086, 0.067, 0.031], p.armor, [0, -0.026, 0.047]);
    softBox(lower, [0.09, 0.032, 0.105], panel, [0, -0.234, 0]);
    const hand = group(torso, side < 0 ? 'support-hand' : 'trigger-hand');
    softBox(hand, [0.068, 0.083, 0.064], p.rubber);
    softBox(hand, [0.054, 0.032, 0.015], panel, [0, 0.003, 0.033]);
    softBox(hand, [0.025, 0.046, 0.036], p.rubber, [-side * 0.035, 0.012, -0.011]);
    return { side, shoulder, upper, lower, hand };
  });
  const gunMount = group(torso, 'weapon-mount', [0.10, 0.30, -0.10]);
  const guns = Object.fromEntries(WEAPON_IDS.map(id => [id, rifle(a, gunMount, id, p, player)]));
  const parachuteRoot = canopy(a, a.root, p);
  // Keep animation pivots; batch rigid details for player and AI alike.
  {
    a.mergeRigid([
      hips, torso, head, gunMount, parachuteRoot,
      ...legs.flatMap(leg => [leg.thigh, leg.shin, leg.boot]),
      ...arms.flatMap(arm => [arm.upper, arm.lower, arm.hand]),
      ...Object.values(guns).map(gun => gun.root),
    ]);
  }
  let phase = 0, crouched = 0, proneAmount = 0, deathAmount = 0;
  function update({ dt, speed = 0, yaw = 0, pitch = 0, crouch = false, prone = false,
    airborne = false, parachute = false, dead = false, weapon = 'm416' }) {
    a.assertLive();
    finite(dt, 'dt');
    if (dt < 0) throw new RangeError('dt must be nonnegative');
    finite(speed, 'speed'); finite(yaw, 'yaw'); finite(pitch, 'pitch');
    if (weapon !== null) weaponId(weapon);
    const blend = 1 - Math.exp(-dt * 13);
    crouched = mix(crouched, crouch && !prone && !airborne && !dead ? 1 : 0, blend);
    proneAmount = mix(proneAmount, prone && !airborne && !dead ? 1 : 0, blend);
    deathAmount = mix(deathAmount, dead ? 1 : 0, blend);
    const moving = clamp(Math.abs(speed) / 3.8, 0, 1) * (1 - deathAmount);
    phase = (phase + dt * (Math.abs(speed) * 2.8 + 1.8)) % TAU;
    a.root.rotation.y = yaw;
    hips.position.y = mix(mix(0.9, 0.53, crouched), 0.25, proneAmount);
    hips.position.y = mix(hips.position.y, 0.27, deathAmount);
    hips.position.x = -deathAmount * 0.2;
    hips.rotation.set(-proneAmount * 1.48 + (airborne ? -0.07 : 0), 0, deathAmount * 1.48);
    torso.rotation.x = -crouched * 0.10;
    torso.rotation.z = Math.sin(phase) * moving * 0.026 * (1 - proneAmount);
    head.rotation.x = proneAmount * 1.48 + clamp(pitch, -0.7, 0.7) * 0.5;
    head.rotation.y = Math.sin(phase * 0.5) * moving * 0.022;
    gunMount.position.set(0.10, mix(0.30, 0.59, proneAmount), mix(-0.10, 0.075, proneAmount));
    gunMount.rotation.set(clamp(pitch, -1.1, 1.1) + proneAmount * 1.48 + crouched * 0.1, 0, 0);
    gunMount.position.y += Math.sin(phase * 2) * moving * 0.009;
    for (const id of WEAPON_IDS) guns[id].root.visible = weapon === id && !parachute;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const stride = Math.sin(phase + i * Math.PI) * moving;
      const swing = mix(stride * 0.64, 1.25 + stride * 0.22, crouched);
      leg.thigh.rotation.x = mix(swing, stride * 0.14, proneAmount);
      leg.shin.rotation.x = mix(Math.max(0, -stride) * 0.75, -2.0, crouched) * (1 - proneAmount);
      leg.thigh.rotation.z = proneAmount * (i ? -0.12 : 0.12);
      leg.boot.rotation.x = -(leg.thigh.rotation.x + leg.shin.rotation.x) * (1 - proneAmount) + proneAmount;
      if (airborne && !dead) { leg.thigh.rotation.x = 0.18 + stride * 0.14; leg.shin.rotation.x = 0.35; }
    }
    // Two-bone IK uses persistent scratch vectors; no geometry or material allocation per frame.
    for (const arm of arms) {
      target.set(0, arm.side > 0 ? -0.102 : -0.045, arm.side > 0 ? 0.02 : -0.275);
      target.applyEuler(gunMount.rotation).add(gunMount.position);
      if (parachute && !dead) target.set(arm.side * 0.25, 0.74, 0.07);
      if (weapon === null && !parachute) target.set(arm.side * 0.25, -0.04, -0.03);
      direction.copy(target).sub(arm.shoulder);
      const distance = clamp(direction.length(), 0.02, 0.548);
      direction.normalize();
      target.copy(arm.shoulder).addScaledVector(direction, distance);
      midpoint.copy(arm.shoulder).addScaledVector(direction, distance * 0.5);
      bend.set(arm.side * 0.7, -1, 0.25);
      bend.addScaledVector(direction, -bend.dot(direction)).normalize();
      midpoint.addScaledVector(bend, Math.sqrt(Math.max(0, 0.275 ** 2 - (distance / 2) ** 2)));
      arm.upper.position.copy(arm.shoulder);
      direction.copy(midpoint).sub(arm.shoulder);
      arm.upper.scale.y = direction.length() / 0.26;
      arm.upper.quaternion.setFromUnitVectors(down, direction.normalize());
      arm.lower.position.copy(midpoint);
      direction.copy(target).sub(midpoint);
      arm.lower.scale.y = direction.length() / 0.26;
      arm.lower.quaternion.setFromUnitVectors(down, direction.normalize());
      arm.hand.position.copy(target);
      arm.hand.rotation.copy(gunMount.rotation);
    }
    parachuteRoot.visible = parachute && !dead;
    parachuteRoot.rotation.z = Math.sin(phase * 0.45) * 0.025;
    parachuteRoot.rotation.x = Math.sin(phase * 0.3) * 0.016;
  }
  update({ dt: 0 });
  return { root: a.root, update, dispose: a.dispose };
}

/** Camera-local weapon rig. All weapons, sights and magazines are constructed once. */
export function createViewmodel() {
  const a = asset('viewmodel');
  const p = palette(a, 0x727b62);
  const mount = group(a.root, 'viewmodel-recoil');
  const guns = Object.fromEntries(WEAPON_IDS.map(id => [id, rifle(a, mount, id, p)]));
  const hands = group(mount, 'first-person-hands');
  const sleeve = (name, from, to) => {
    const root = group(hands, name);
    a.bar(root, from, to, 0.054, p.cloth, 8);
    a.sphere(root, 0.048, p.rubber, to, [0.92, 1.15, 1]);
    a.box(root, [0.075, 0.049, 0.074], p.rubber, to);
    return root;
  };
  sleeve('trigger-arm', [0.22, -0.30, 0.34], [0.013, -0.12, 0.033]);
  const support = sleeve('support-arm', [-0.26, -0.29, 0.20], [-0.012, -0.073, -0.28]);
  a.box(support, [0.048, 0.026, 0.076], p.darkCloth, [-0.039, -0.039, -0.27]);
  const flashMaterial = a.material(0xffda7c, { emissive: 0xffad36, emissiveIntensity: 5,
    transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
  const flash = group(mount, 'muzzle-flash');
  const cone = a.geometry('flash', () => new THREE.ConeGeometry(0.048, 0.18, 5));
  a.mesh(flash, cone, flashMaterial, [0, 0, -0.055], [-Math.PI / 2, 0, 0]);
  a.mesh(flash, cone, flashMaterial, [0, 0, -0.025], [-Math.PI / 2, 0, 0.65]).scale.set(0.55, 0.65, 0.55);
  let active = 'm416', aimAmount = 0, phase = 0, flashTime = 0, lastRecoil = 0;
  a.root.traverse(object => { if (object.isMesh) { object.castShadow = false; object.receiveShadow = false; } });
  function setWeapon(id) {
    a.assertLive();
    if (id !== null) weaponId(id);
    active = id;
    for (const key of WEAPON_IDS) guns[key].root.visible = key === id;
    a.root.visible = id !== null;
    flashTime = 0;
    flash.visible = false;
    lastRecoil = 0;
  }
  function update({ dt, speed = 0, aim = false, reload = 0, recoil = 0 }) {
    a.assertLive();
    finite(dt, 'dt'); finite(speed, 'speed'); finite(reload, 'reload'); finite(recoil, 'recoil');
    if (dt < 0) throw new RangeError('dt must be nonnegative');
    if (reload < 0 || reload > 1) throw new RangeError('reload must be in [0, 1]');
    if (recoil < 0) throw new RangeError('recoil must be nonnegative');
    if (active === null) { a.root.visible = false; return; }
    const gun = guns[active];
    phase = (phase + dt * (2 + Math.abs(speed) * 2.4)) % TAU;
    aimAmount = mix(aimAmount, aim && !reload ? 1 : 0, 1 - Math.exp(-dt * 18));
    const bob = clamp(Math.abs(speed) / 5, 0, 1) * (1 - aimAmount * 0.88);
    const cycle = Math.sin(reload * Math.PI);
    const kick = Math.min(recoil * 10, 1.5) * (active === 'kar98' ? 1.35 : active === 'ump45' ? 0.7 : 1);
    a.root.position.set(mix(0.245, 0, aimAmount) + Math.sin(phase) * bob * 0.008,
      mix(-0.245, -gun.spec.sight, aimAmount) + Math.cos(phase * 2) * bob * 0.006 - cycle * 0.08,
      mix(-0.43, -0.28, aimAmount));
    mount.position.set(-cycle * 0.07, -kick * 0.007, kick * 0.066);
    mount.rotation.set(kick * 0.11 - cycle * 0.28, cycle * 0.18, cycle * 0.53 + Math.sin(phase) * bob * 0.008);
    const extraction = reload > 0 ? Math.sin(clamp((reload - 0.15) / 0.68, 0, 1) * Math.PI) : 0;
    const magazineTravel = active === 'kar98' ? 0 : extraction;
    gun.magazine.position.set(-magazineTravel * 0.07, -0.061 - magazineTravel * 0.24, -0.133);
    gun.magazine.rotation.z = magazineTravel * 0.22;
    gun.magazine.visible = active === 'kar98' || !(reload > 0.38 && reload < 0.56);
    gun.bolt.position.z = 0.035 + (active === 'kar98' ? (kick + extraction) * 0.065 : kick * 0.025);
    support.position.set(-extraction * 0.04, -extraction * 0.20, extraction * 0.17);
    support.rotation.z = extraction * -0.32;
    flashTime = Math.max(0, flashTime - dt);
    if (recoil > lastRecoil + 0.015 && !reload) flashTime = 0.045;
    lastRecoil = recoil;
    flash.visible = flashTime > 0 && !reload;
    flash.position.set(0, 0.025, gun.spec.barrel - 0.04);
    flash.rotation.z = phase * 5;
  }
  setWeapon('m416');
  update({ dt: 0 });
  return { root: a.root, setWeapon, update, dispose: a.dispose };
}

const LOOT_COLORS = { weapon: 0xe4b96a, ammo: 0x91bf64, medkit: 0xe9e4d7,
  boost: 0x59b7ec, armor: 0x69a29e, helmet: 0x8bad6e, grenade: 0xc0a254 };
export function createLootMesh(loot) {
  if (!loot || !Object.hasOwn(LOOT_COLORS, loot.kind)) throw new TypeError('Unknown loot kind');
  if (loot.kind === 'weapon') weaponId(loot.id);
  if (loot.kind === 'ammo' && !['556', '762', '9mm'].includes(loot.id)) throw new RangeError(`Unknown ammo: ${loot.id}`);
  const level = loot.level ?? 1;
  if ((loot.kind === 'armor' || loot.kind === 'helmet') && (!Number.isInteger(level) || level < 1 || level > 3)) {
    throw new RangeError('Loot level must be 1, 2, or 3');
  }
  const a = asset(`loot-${loot.kind}`);
  a.root.userData.loot = { ...loot };
  const p = palette(a);
  const accentColor = loot.kind === 'weapon' ? GUN_SPEC[loot.id].color : LOOT_COLORS[loot.kind];
  const accent = a.material(accentColor, { emissive: accentColor, emissiveIntensity: 0.18 });
  a.cylinder(a.root, 0.235, 0.235, 0.017, p.rubber, [0, 0.009, 0], undefined, 24);
  a.mesh(a.root, a.geometry('loot-ring', () => new THREE.TorusGeometry(0.222, 0.006, 4, 24)),
    accent, [0, 0.022, 0], [Math.PI / 2, 0, 0]);
  const item = group(a.root, 'item', [0, 0.04, 0]);
  if (loot.kind === 'weapon') {
    const gun = rifle(a, item, loot.id, p, false);
    gun.root.scale.setScalar(0.47);
    gun.root.position.set(0, 0.13, loot.id === 'kar98' ? 0.14 : 0.075);
  } else if (loot.kind === 'ammo') {
    const ammoColor = { '556': 0x638c45, '762': 0xb66b43, '9mm': 0x4189b4 }[loot.id];
    const paper = a.material(ammoColor);
    const brass = a.material(0xc6a95d, { metalness: 0.72, roughness: 0.3 });
    a.box(item, [0.23, 0.15, 0.15], paper, [0, 0.075, 0]);
    a.box(item, [0.238, 0.026, 0.156], p.tan, [0, 0.153, 0]);
    a.box(item, [0.16, 0.065, 0.004], p.tan, [0, 0.082, -0.077]);
    const marks = loot.id === '556' ? 3 : loot.id === '762' ? 2 : 1;
    for (let i = 0; i < marks; i++) a.box(item, [0.019, 0.04, 0.006], paper,
      [(i - (marks - 1) / 2) * 0.04, 0.082, -0.081]);
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 0.044;
      a.cylinder(item, 0.015, 0.016, 0.075, brass, [x, 0.197, 0], undefined, 8);
      a.cylinder(item, 0.003, 0.015, 0.028, p.wood, [x, 0.248, 0], undefined, 8);
    }
  } else if (loot.kind === 'medkit') {
    a.box(item, [0.28, 0.22, 0.17], accent, [0, 0.11, 0]);
    a.box(item, [0.287, 0.018, 0.177], p.red, [0, 0.17, 0]);
    a.box(item, [0.043, 0.127, 0.009], p.red, [0, 0.103, -0.091]);
    a.box(item, [0.128, 0.043, 0.01], p.red, [0, 0.103, -0.092]);
    a.bar(item, [-0.059, 0.23, 0], [-0.059, 0.264, 0], 0.012, p.rubber);
    a.bar(item, [0.059, 0.23, 0], [0.059, 0.264, 0], 0.012, p.rubber);
    a.bar(item, [-0.059, 0.264, 0], [0.059, 0.264, 0], 0.012, p.rubber);
  } else if (loot.kind === 'boost') {
    a.cylinder(item, 0.067, 0.065, 0.235, accent, [0, 0.123, 0], undefined, 16);
    for (const y of [0.015, 0.239]) a.cylinder(item, 0.069, 0.069, 0.012, p.steel, [0, y, 0], undefined, 16);
    a.box(item, [0.089, 0.069, 0.007], p.light, [0, 0.13, -0.065], [0, 0, -0.22]);
    a.box(item, [0.027, 0.1, 0.009], p.red, [0.012, 0.13, -0.069], [0, 0, -0.22]);
    a.box(item, [0.025, 0.004, 0.047], p.rubber, [0, 0.247, -0.008]);
  } else if (loot.kind === 'armor') {
    a.box(item, [0.27, 0.27, 0.115], p.armor, [0, 0.155, 0]);
    a.box(item, [0.21, 0.2, 0.024], accent, [0, 0.17, -0.07]);
    for (const x of [-0.11, 0.11]) a.box(item, [0.041, 0.1, 0.11], p.webbing, [x, 0.306, 0]);
    for (let i = 0; i < 3; i++) a.box(item, [0.225, 0.011, 0.009], p.webbing, [0, 0.11 + i * 0.042, -0.086]);
  } else if (loot.kind === 'helmet') {
    a.mesh(item, a.geometry('loot-helmet', () => new THREE.SphereGeometry(0.161, 12, 7, 0, TAU, 0, Math.PI * 0.57)),
      accent, [0, 0.12, 0]);
    a.box(item, [0.262, 0.022, 0.094], p.armor, [0, 0.11, -0.098]);
    for (const x of [-0.13, 0.13]) a.box(item, [0.017, 0.095, 0.07], p.webbing, [x, 0.05, 0]);
    if (level === 3) a.box(item, [0.253, 0.085, 0.022], p.glass, [0, 0.074, -0.142]);
  } else {
    a.sphere(item, 0.096, p.armor, [0, 0.105, 0], [0.9, 1.15, 0.9]);
    for (const y of [0.06, 0.107, 0.154]) a.cylinder(item, 0.09, 0.09, 0.012, p.webbing, [0, y, 0]);
    a.cylinder(item, 0.038, 0.043, 0.044, p.metal, [0, 0.215, 0]);
    a.box(item, [0.03, 0.014, 0.1], p.steel, [0, 0.243, 0.026]);
    a.box(item, [0.03, 0.121, 0.019], p.steel, [0, 0.19, 0.079], [-0.2, 0, 0]);
    a.mesh(item, a.geometry('grenade-ring', () => new THREE.TorusGeometry(0.03, 0.004, 5, 12)),
      p.steel, [-0.05, 0.233, -0.009], [0, Math.PI / 2, 0]);
  }
  if (loot.kind === 'armor' || loot.kind === 'helmet') {
    for (let i = 0; i < level; i++) a.box(a.root, [0.032, 0.008, 0.014], p.light,
      [(i - (level - 1) / 2) * 0.046, 0.03, -0.193]);
  }
  return a.root;
}

/** Enemy death container. Feet are at y=0; owned geometry follows the normal asset disposal path. */
export function createDeathCrate() {
  const a=asset('death-loot-crate');
  const wood=a.material(0x76552f,{roughness:1});
  const lid=a.material(0x967044,{roughness:1});
  const metal=a.material(0x343b32,{metalness:.5,roughness:.65});
  a.box(a.root,[1,.42,.66],wood,[0,.23,0]);
  a.box(a.root,[1.04,.07,.7],lid,[0,.475,0]);
  for(const x of [-.33,.33])a.box(a.root,[.075,.49,.72],metal,[x,.255,0]);
  for(const z of [-.337,.337])a.box(a.root,[.96,.026,.018],lid,[0,.24,z]);
  a.box(a.root,[.14,.13,.04],metal,[0,.42,-.37]);
  const glow=a.material(0x7fff71,{emissive:0x62f05e,emissiveIntensity:.8,transparent:true,opacity:.24,depthWrite:false,side:THREE.DoubleSide});
  const marker=a.mesh(a.root,a.geometry('crate-marker',()=>new THREE.CylinderGeometry(.07,.22,.9,6,1,true)),glow,[0,.95,0]);
  marker.castShadow=false;marker.receiveShadow=false;
  a.root.userData.marker=marker;
  return a.root;
}

/** Compact open-top 4x4. The four wheel groups rotate around their local X axis. */
export function createVehicle() {
  const a = asset('jeep');
  const p = palette(a, 0x68735c);
  const body = group(a.root, 'body');
  a.box(body, [1.47, 0.2, 3.12], p.metal, [0, 0.42, 0]);
  a.box(body, [1.58, 0.18, 2.82], p.cloth, [0, 0.65, 0.08]);
  a.box(body, [1.55, 0.44, 1.05], p.cloth, [0, 0.94, -1.055]);
  a.box(body, [1.58, 0.055, 1.11], p.darkCloth, [0, 1.184, -1.075]);
  a.box(body, [1.38, 0.37, 0.05], p.rubber, [0, 0.945, -1.603]);
  for (let i = 0; i < 7; i++) a.box(body, [0.075, 0.288, 0.067], p.cloth, [(i - 3) * 0.108, 0.957, -1.636]);
  for (const side of [-1, 1]) {
    a.cylinder(body, 0.127, 0.127, 0.035, p.metal, [side * 0.568, 1.034, -1.639], [Math.PI / 2, 0, 0], 16);
    a.cylinder(body, 0.101, 0.101, 0.039, p.light, [side * 0.568, 1.034, -1.66], [Math.PI / 2, 0, 0], 16);
    a.box(body, [0.135, 0.058, 0.025], p.red, [side * 0.65, 0.846, 1.59]);
    a.box(body, [0.16, 0.35, 1.14], p.cloth, [side * 0.733, 0.82, 0.975]);
    a.box(body, [0.085, 0.18, 1.42], p.cloth, [side * 0.748, 0.754, -0.01]);
    for (const z of [-1.1, 1.09]) a.box(body, [0.28, 0.07, 0.83], p.darkCloth, [side * 0.816, 0.84, z]);
    a.box(body, [0.29, 0.055, 1.15], p.metal, [side * 0.85, 0.52, 0.02]);
    a.bar(body, [side * 0.728, 1.1, -0.55], [side * 0.728, 1.92, -0.39], 0.038, p.metal);
    a.bar(body, [side * 0.718, 0.76, 0.61], [side * 0.718, 1.95, 0.61], 0.043, p.metal);
    a.bar(body, [side * 0.718, 1.95, 0.61], [side * 0.718, 1.92, -0.39], 0.037, p.metal);
    a.bar(body, [side * 0.718, 1.86, 0.61], [side * 0.718, 0.98, 1.40], 0.035, p.metal);
    a.bar(body, [side * 0.77, 1.36, -0.45], [side * 0.94, 1.37, -0.48], 0.021, p.metal);
    a.box(body, [0.055, 0.16, 0.14], p.rubber, [side * 0.98, 1.40, -0.48]);
    a.box(body, [0.059, 0.129, 0.118], p.glass, [side * 0.983, 1.40, -0.457]);
    const seat = group(body, 'seat', [side * 0.385, 0.77, 0.07]);
    a.box(seat, [0.52, 0.12, 0.52], p.rubber);
    a.box(seat, [0.51, 0.53, 0.105], p.darkCloth, [0, 0.23, 0.22], [-0.10, 0, 0]);
    a.box(seat, [0.25, 0.16, 0.11], p.rubber, [0, 0.55, 0.246]);
    a.bar(body, [side * 0.63, 1.29, 0.31], [side * 0.17, 0.84, -0.09], 0.018, p.webbing);
  }
  a.box(body, [1.54, 0.45, 0.11], p.cloth, [0, 0.92, 1.49]);
  a.box(body, [1.28, 0.12, 0.45], p.rubber, [0, 0.83, 1.02]);
  a.box(body, [1.27, 0.35, 0.085], p.darkCloth, [0, 1.07, 1.26]);
  a.bar(body, [-0.72, 1.95, 0.61], [0.72, 1.95, 0.61], 0.042, p.metal);
  for (const y of [1.18, 1.91]) a.bar(body, [-0.74, y, y > 1.5 ? -0.393 : -0.534],
    [0.74, y, y > 1.5 ? -0.393 : -0.534], 0.035, p.metal);
  a.bar(body, [0, 1.19, -0.53], [0, 1.91, -0.392], 0.021, p.metal);
  const windshield = a.material(0x9eb9b1, { transparent: true, opacity: 0.24, roughness: 0.1,
    metalness: 0.15, depthWrite: false, side: THREE.DoubleSide });
  a.box(body, [1.39, 0.70, 0.012], windshield, [0, 1.546, -0.46], [0.19, 0, 0]);
  a.box(body, [1.43, 0.24, 0.17], p.rubber, [0, 1.13, -0.39]);
  for (const x of [-0.38, -0.17, 0.02]) {
    a.cylinder(body, x < -0.3 ? 0.066 : 0.043, x < -0.3 ? 0.066 : 0.043, 0.009,
      p.steel, [x, 1.151, -0.298], [Math.PI / 2, 0, 0], 12);
    a.box(body, [0.008, 0.047, 0.012], p.light, [x, 1.157, -0.286], [0, 0, -0.45]);
  }
  const steering = group(body, 'steering-wheel', [-0.38, 1.19, -0.17]);
  steering.rotation.x = -0.44;
  a.mesh(steering, a.geometry('steering-ring', () => new THREE.TorusGeometry(0.165, 0.019, 6, 16)), p.rubber);
  for (let i = 0; i < 3; i++) a.bar(steering, [0, 0, 0],
    [Math.cos(i * TAU / 3) * 0.15, Math.sin(i * TAU / 3) * 0.15, 0], 0.012, p.metal);
  a.bar(body, [0.05, 0.69, -0.02], [0.05, 0.97, -0.12], 0.017, p.metal);
  a.sphere(body, 0.037, p.rubber, [0.05, 0.97, -0.12]);
  for (const z of [-1.765, 1.7]) a.box(body, [1.80, 0.13, 0.16], p.metal, [0, 0.61, z]);
  for (const x of [-0.54, 0.54]) a.bar(body, [x, 0.65, -1.8], [x, 0.88, -1.8], 0.025, p.metal);
  const tire = (parent, name, position, spare = false) => {
    const pivot = group(parent, name, position);
    if (spare) pivot.rotation.y = Math.PI / 2;
    a.cylinder(pivot, 0.38, 0.38, 0.265, p.rubber, undefined, [0, 0, Math.PI / 2], 16);
    for (const side of [-1, 1]) {
      a.cylinder(pivot, 0.222, 0.222, 0.018, p.cloth, [side * 0.14, 0, 0], [0, 0, Math.PI / 2], 12);
      a.cylinder(pivot, 0.075, 0.075, 0.043, p.metal, [side * 0.156, 0, 0], [0, 0, Math.PI / 2], 8);
      for (let i = 0; i < 5; i++) {
        const angle = i * TAU / 5;
        a.cylinder(pivot, 0.019, 0.019, 0.022, p.steel,
          [side * 0.16, Math.sin(angle) * 0.115, Math.cos(angle) * 0.115], [0, 0, Math.PI / 2], 6);
      }
    }
    for (let i = 0; i < 16; i++) {
      const angle = i * TAU / 16;
      a.box(pivot, [0.275, 0.027, 0.103], p.rubber,
        [0, Math.cos(angle) * 0.366, Math.sin(angle) * 0.366], [angle, 0, 0]);
    }
  };
  for (const x of [-0.87, 0.87]) for (const z of [-1.10, 1.08]) tire(a.root, 'wheel', [x, 0.38, z]);
  for (const z of [-1.10, 1.08]) a.bar(body, [-0.9, 0.38, z], [0.9, 0.38, z], 0.055, p.metal);
  tire(body, 'spare-wheel', [0.31, 1.07, 1.71], true);
  a.box(body, [0.33, 0.45, 0.19], p.darkCloth, [-0.51, 1.01, 1.63]);
  a.bar(body, [-0.63, 1.26, 1.63], [-0.39, 1.26, 1.63], 0.02, p.metal);
  a.bar(body, [0.67, 1.03, 1.3], [0.69, 2.18, 1.4], 0.008, p.metal);
  return a.root;
}

/** Four-engine transport, about 35 m long with its nose on -Z. */
export function createPlane() {
  const a = asset('transport-plane');
  const p = palette(a, 0x77817c);
  const hull = a.material(0x8e9891, { metalness: 0.3, roughness: 0.58, flatShading: true });
  const lowerHull = a.material(0x505e5d, { metalness: 0.3, roughness: 0.65 });
  const fuselage = a.geometry('fuselage', () => {
    const rings = [[-17.5, 0.06], [-16.7, 0.85], [-14.4, 1.7], [-11, 1.98],
      [-6, 2.02], [5.2, 1.97], [10.8, 1.35], [15.1, 0.65], [17.5, 0.08]];
    const positions = [], indices = [];
    for (const [z, radius] of rings) for (let i = 0; i <= 16; i++) {
      const angle = i * TAU / 16;
      positions.push(Math.sin(angle) * radius, 2.75 + Math.cos(angle) * radius * 0.91, z);
    }
    for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < 16; i++) {
      const n = j * 17 + i;
      indices.push(n, n + 17, n + 1, n + 1, n + 17, n + 18);
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.setIndex(indices);
    result.computeVertexNormals();
    return result;
  });
  a.mesh(a.root, fuselage, hull);
  a.box(a.root, [2.29, 0.38, 10.5], lowerHull, [0, 1.26, -0.4]);
  for (const side of [-1, 1]) {
    a.slab(a.root, [[0, -4.2], [side * 5, -3.2], [side * 15.7, 0.65],
      [side * 15.3, 3.1], [side * 5.2, 1.2], [0, 2.4]], 0.25, p.cloth, [0, 3.62, 0]);
    a.slab(a.root, [[side * 2, 0.45], [side * 13.9, 2.28], [side * 13.7, 2.8],
      [side * 2, 1.3]], 0.055, lowerHull, [0, 3.78, 0]);
    a.slab(a.root, [[0, 10.4], [side * 6.4, 12.6], [side * 6.0, 14.5], [0, 14.1]], 0.15, hull, [0, 3.51, 0]);
    for (let i = 0; i < 7; i++) a.box(a.root, [0.035, 0.30, 0.37], p.glass,
      [side * 1.99, 3.05, -7.5 + i * 1.5]);
    a.box(a.root, [0.028, 1.16, 0.84], lowerHull, [side * 1.8, 2.30, 7.1]);
    a.box(a.root, [0.039, 0.16, 0.27], p.glass, [side * 1.825, 2.57, 7.1]);
    for (const engineX of [5.0, 9.1]) {
      const z = engineX > 6 ? -0.42 : -1.75;
      const engine = group(a.root, 'engine', [side * engineX, 3.02, z]);
      a.cylinder(engine, 0.65, 0.72, 3.2, hull, [0, 0, 0], [Math.PI / 2, 0, 0], 12);
      a.cylinder(engine, 0.52, 0.63, 0.20, p.rubber, [0, 0, -1.67], [Math.PI / 2, 0, 0], 12);
      a.cylinder(engine, 0.19, 0.32, 0.38, p.steel, [0, 0, -1.9], [Math.PI / 2, 0, 0], 10);
      const propeller = group(engine, 'propeller', [0, 0, -1.94]);
      for (let i = 0; i < 4; i++) {
        const blade = group(propeller, 'blade');
        blade.rotation.z = i * Math.PI / 2 + 0.25;
        a.box(blade, [0.19, 1.54, 0.051], p.rubber, [0.06, 0.89, 0], [0, 0.12, -0.07]);
        a.box(blade, [0.20, 0.18, 0.058], p.tan, [0.11, 1.56, 0], [0, 0.12, -0.07]);
      }
      a.cylinder(engine, 0.23, 0.31, 0.43, hull, [0, 0, -2.17], [-Math.PI / 2, 0, 0]);
    }
    a.box(a.root, [0.93, 0.58, 0.075], p.glass, [side * 0.63, 3.65, -14.65], [-0.43, side * -0.36, 0]);
    a.box(a.root, [0.07, 0.58, 1.11], p.glass, [side * 1.48, 3.48, -13.80], [0, side * 0.20, 0]);
    a.bar(a.root, [side * 0.99, 3.95, -14.5], [side * 1.52, 3.73, -13.2], 0.036, p.metal);
    const nav = a.material(side < 0 ? 0xee493c : 0x6cd38c,
      { emissive: side < 0 ? 0xee493c : 0x6cd38c, emissiveIntensity: 2 });
    a.sphere(a.root, 0.105, nav, [side * 15.5, 3.68, 1.23]);
    a.box(a.root, [0.07, 0.44, 1.42], p.tan, [side * 1.98, 2.71, -0.7]);
    a.box(a.root, [0.085, 0.88, 0.38], p.tan, [side * 1.98, 2.71, -0.7]);
  }
  const fin = group(a.root, 'tail-fin', [0, 3.12, 0]);
  const vertical = a.slab(fin, [[0, 8.4], [4.75, 12.8], [4.55, 15.6], [0, 16.4]], 0.20, p.cloth);
  vertical.rotation.z = Math.PI / 2;
  a.box(a.root, [0.225, 1.0, 1.57], p.tan, [0, 6.75, 13.69], [-0.1, 0, 0]);
  a.box(a.root, [1.54, 0.095, 3.5], lowerHull, [0, 1.49, 10.25], [0.18, 0, 0]);
  a.bar(a.root, [0, 4.68, -2], [0, 5.38, -2.15], 0.036, p.metal);
  a.root.userData.forward = '-Z';
  return a.root;
}
