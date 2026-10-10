import * as THREE from 'three';
import {
  MAP_SIZE, LOCATIONS, ROADS, BRIDGES, FIELD_PLOTS, heightAt, terrainHeightAt,
  terrainNoise, coastRadiusAt, riverCenterAt, distanceToRoad, createRandom, smoothstep,
} from './terrain.js';

const PALETTE = {
  plaster: [0xe0d5bd, 0xd4c4aa, 0xc9d0c5, 0xe4ded0],
  red: 0xa64736, blue: 0x38657e, trim: 0xf0dfbd, asphalt: 0x565953,
  trunk: 0x65533b, leaves: [0x476644, 0x526e45, 0x69814d, 0x3f614b],
};
const CLEARANCE = 1.15;
const TREE_COUNTS = { high: 1050, low: 370 };
const GRASS_COUNTS = { high: 2400, low: 550 };

function triangleGeometry(vertices, indices) {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  return geometry;
}

function makeResources() {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  return {
    geometry(value) { geometries.add(value); return value; },
    material(value) { materials.add(value); return value; },
    texture(value) { textures.add(value); return value; },
    dispose() {
      for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
      geometries.clear(); materials.clear(); textures.clear();
    },
  };
}

// One instanced batch per geometry/material, not one mesh per house, wall, leaf or crop.
function makeBatches(root) {
  const batches = new Map();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const color = new THREE.Color();
  return {
    add(geometry, material, x, y, z, sx, sy, sz, tint, yaw = 0, tilt = 0, shadow = true) {
      const key = `${geometry.uuid}:${material.uuid}:${shadow}`;
      if (!batches.has(key)) batches.set(key, { geometry, material, shadow, items: [] });
      batches.get(key).items.push([x, y, z, sx, sy, sz, tint, yaw, tilt]);
    },
    flush() {
      for (const { geometry, material, items, shadow } of batches.values()) {
        const mesh = new THREE.InstancedMesh(geometry, material, items.length);
        mesh.name = `world-batch:${geometry.name || geometry.type}:${items.length}`;
        mesh.castShadow = shadow;
        mesh.receiveShadow = true;
        items.forEach(([x, y, z, sx, sy, sz, tint, yaw, tilt], index) => {
          position.set(x, y, z); scale.set(sx, sy, sz);
          rotation.setFromEuler(euler.set(0, yaw, tilt));
          matrix.compose(position, rotation, scale);
          mesh.setMatrixAt(index, matrix);
          mesh.setColorAt(index, color.setHex(tint));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        root.add(mesh);
      }
      batches.clear();
    },
  };
}

function makeTerrain(root, resources, low) {
  const material = resources.material(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  const tiles = 7;
  const segments = low ? 24 : 40;
  const tileSize = MAP_SIZE / tiles;
  const sand = new THREE.Color(0xc2b28a);
  const grass = new THREE.Color(0x7d8957);
  const forest = new THREE.Color(0x65784c);
  const rock = new THREE.Color(0x898775);
  const color = new THREE.Color();
  for (let tz = 0; tz < tiles; tz++) {
    for (let tx = 0; tx < tiles; tx++) {
      const geometry = resources.geometry(new THREE.PlaneGeometry(tileSize, tileSize, segments, segments));
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(-MAP_SIZE / 2 + (tx + 0.5) * tileSize, 0, -MAP_SIZE / 2 + (tz + 0.5) * tileSize);
      const vertices = geometry.attributes.position;
      const colors = new Float32Array(vertices.count * 3);
      for (let i = 0; i < vertices.count; i++) {
        const x = vertices.getX(i);
        const z = vertices.getZ(i);
        const y = terrainHeightAt(x, z);
        vertices.setY(i, y);
        const variation = terrainNoise(x / 24, z / 24);
        color.copy(grass).lerp(forest, variation * 0.7);
        color.lerp(sand, 1 - smoothstep(0.5, 7, y));
        color.lerp(rock, smoothstep(35, 75, y) * 0.68);
        color.multiplyScalar(0.92 + terrainNoise(x / 5, z / 5) * 0.16);
        color.toArray(colors, i * 3);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `island-ground:${tx}:${tz}`;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
  }
}

function makeRoads(root, resources) {
  const surfaces = [[], [], []];
  function quad(target, points) {
    for (const index of [0, 1, 2, 2, 1, 3]) target.push(...points[index]);
  }
  function ribbon(target, road, start, end, halfWidth, offset, lift) {
    const dx = (road.b.x - road.a.x) / road.length;
    const dz = (road.b.z - road.a.z) / road.length;
    const points = [];
    for (const along of [start, end]) {
      for (const side of [-1, 1]) {
        const lateral = offset + side * halfWidth;
        const x = road.a.x + dx * along - dz * lateral;
        const z = road.a.z + dz * along + dx * lateral;
        points.push([x, heightAt(x, z) + lift, z]);
      }
    }
    quad(target, points);
  }
  for (const road of ROADS) {
    const steps = Math.ceil(road.length / 3);
    for (let i = 0; i < steps; i++) {
      const start = road.length * i / steps;
      const end = road.length * (i + 1) / steps;
      ribbon(surfaces[0], road, start, end, road.bridge ? 5.8 : 6.4, 0, 0.035);
      ribbon(surfaces[1], road, start, end, road.width / 2, 0, 0.065);
    }
    // Stop paint short of junctions; no intersecting stripes through the village squares.
    for (let along = 16; along < road.length - 16; along += 11) {
      ribbon(surfaces[2], road, along, Math.min(along + 4.5, road.length - 16), 0.085, 0, 0.085);
    }
  }
  [0xa89f82, PALETTE.asphalt, 0xd6c9a0].forEach((color, index) => {
    const geometry = resources.geometry(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(surfaces[index], 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = resources.material(new THREE.MeshStandardMaterial({ color, roughness: 1, polygonOffset: true,
      polygonOffsetFactor: -1 - index, polygonOffsetUnits: -1 - index }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = ['road-shoulders', 'road-asphalt', 'road-markings'][index];
    mesh.receiveShadow = true;
    root.add(mesh);
  });
}

function makeAtmosphere(scene, root, resources) {
  const previous = { background: scene.background, fog: scene.fog };
  const background = new THREE.Color(0xb6cdd2);
  const fog = new THREE.Fog(0xb6cdd2, 650, 2100);
  // Main owns illumination and its player-following shadow camera. These vectors only shade the sky/water.
  const sunDirection = new THREE.Vector3(-110, 190, 110).normalize();

  const skyMaterial = resources.material(new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { sunDirection: { value: sunDirection } },
    vertexShader: 'varying vec3 vDirection; void main(){ vDirection=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 sunDirection; varying vec3 vDirection;
      void main(){
        vec3 direction=normalize(vDirection);
        float altitude=max(direction.y,0.0);
        vec3 sky=mix(vec3(0.68,0.79,0.82),vec3(0.23,0.48,0.68),pow(altitude,0.55));
        float glow=pow(max(dot(direction,sunDirection),0.0),32.0);
        float disc=smoothstep(0.99955,0.9998,dot(direction,sunDirection));
        sky+=vec3(0.24,0.19,0.1)*glow+vec3(1.0,0.85,0.57)*disc;
        gl_FragColor=vec4(sky,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  const sky = new THREE.Mesh(resources.geometry(new THREE.SphereGeometry(1900, 24, 12)), skyMaterial);
  sky.name = 'sky-dome'; sky.renderOrder = -10;
  root.add(sky);

  const waterMaterial = resources.material(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    uniforms: { time: { value: 0 }, sunDirection: { value: sunDirection } },
    vertexShader: `varying vec3 vWorld; void main(){
      vec4 world=modelMatrix*vec4(position,1.0); vWorld=world.xyz;
      gl_Position=projectionMatrix*viewMatrix*world;
    }`,
    fragmentShader: `uniform float time; uniform vec3 sunDirection; varying vec3 vWorld;
      void main(){
        vec2 p=vWorld.xz;
        float a=sin(p.x*0.12+p.y*0.065+time*0.9)+0.35*sin(p.y*0.31+time*1.3);
        float b=cos(p.y*0.19-p.x*0.043-time*0.63)+0.28*sin(p.x*0.27+p.y*0.13-time);
        vec3 normal=normalize(vec3(a*0.075,1.0,b*0.065));
        vec3 viewDirection=normalize(cameraPosition-vWorld);
        float fresnel=pow(1.0-max(dot(normal,viewDirection),0.0),3.0);
        float sparkle=pow(max(dot(reflect(-sunDirection,normal),viewDirection),0.0),100.0);
        vec3 water=mix(vec3(0.055,0.29,0.34),vec3(0.39,0.63,0.67),fresnel);
        water+=(a+b)*0.012+sparkle*vec3(0.24,0.21,0.15);
        float mist=smoothstep(500.0,1650.0,length(cameraPosition.xz-p));
        water=mix(water,vec3(0.68,0.79,0.82),mist);
        gl_FragColor=vec4(water,0.93);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  const waterGeometry = resources.geometry(new THREE.PlaneGeometry(5200, 5200));
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.name = 'ocean-and-river'; water.position.y = 0; water.renderOrder = 1;
  root.add(water);
  // Commit shared scene state only after all atmosphere resources were created successfully.
  scene.background = background;
  scene.fog = fog;
  return {
    update(elapsed) { waterMaterial.uniforms.time.value = elapsed; },
    dispose() {
      if (scene.background === background) scene.background = previous.background;
      if (scene.fog === fog) scene.fog = previous.fog;
    },
  };
}

function makeSign(location, position, root, resources, box) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 160;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('World POI signs require a Canvas 2D context');
  context.fillStyle = '#263d3d'; context.fillRect(0, 0, 512, 160);
  context.strokeStyle = '#c8c9a4'; context.lineWidth = 5; context.strokeRect(9, 9, 494, 142);
  context.textAlign = 'center'; context.fillStyle = '#f3edce';
  context.font = 'bold 66px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  context.fillText(location.name, 256, 88);
  context.font = '18px sans-serif'; context.fillStyle = '#a7bbb3';
  context.fillText('海岛战场  /  ISLAND FRONTIER', 256, 130);
  const texture = resources.texture(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = resources.material(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, side: THREE.DoubleSide }));
  const geometry = resources.geometry(new THREE.PlaneGeometry(9.6, 3));
  const mesh = new THREE.Mesh(geometry, material);
  const { x, z } = position;
  const y = heightAt(x, z);
  mesh.position.set(x, y + 4.1, z); mesh.name = `poi-sign:${location.name}`;
  root.add(mesh);
  box(x, y + 4.1, z, 9.8, 3.15, 0.16, 0x344840, true);
  for (const side of [-1, 1]) box(x + side * 3.8, y + 1.8, z, 0.22, 3.6, 0.22, 0x52605a, true);
  // Offset the printed face from the solid backing in the same orientation.
  mesh.position.z += 0.091;
}

export function createWorld(scene, { quality = 'high', seed = 2026 } = {}) {
  if (!scene?.isScene) throw new TypeError('createWorld requires a THREE.Scene');
  if (quality !== 'high' && quality !== 'low') throw new RangeError('World quality must be high or low');
  const random = createRandom(seed);
  const low = quality === 'low';
  const resources = makeResources();
  const root = new THREE.Group();
  root.name = '海岛战场 · 原创程序化海岛';
  const batches = makeBatches(root);
  const colliders = [];
  const lootSpawns = [];
  const spawnPoints = [];
  const buildings = [];
  const geometry = {
    box: resources.geometry(new THREE.BoxGeometry(1, 1, 1)),
    trunk: resources.geometry(new THREE.CylinderGeometry(0.72, 1, 1, low ? 5 : 7)),
    crown: resources.geometry(new THREE.IcosahedronGeometry(1, 0)),
    pine: resources.geometry(new THREE.ConeGeometry(1, 1, low ? 5 : 7)),
    rock: resources.geometry(new THREE.DodecahedronGeometry(1, 0)),
    roof: resources.geometry(triangleGeometry(
      [-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5],
      [0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3],
    )),
    grass: resources.geometry(triangleGeometry(
      [-0.55, 0, 0, 0.1, 1, 0, 0.55, 0, 0, 0, 0, -0.5, 0, 0.85, 0.1, 0, 0, 0.5],
      [0, 1, 2, 3, 4, 5],
    )),
  };
  for (const [name, value] of Object.entries(geometry)) value.name = name;
  const materials = {
    solid: resources.material(new THREE.MeshStandardMaterial({ roughness: 0.93 })),
    foliage: resources.material(new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true })),
    glass: resources.material(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.4 })),
    grass: resources.material(new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide })),
    cloud: resources.material(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true })),
  };
  function collider(x, y, z, width, height, depth) {
    colliders.push({ minX: x - width / 2, maxX: x + width / 2, minY: y - height / 2,
      maxY: y + height / 2, minZ: z - depth / 2, maxZ: z + depth / 2 });
  }
  function box(x, y, z, width, height, depth, color, solid = false, material = materials.solid) {
    batches.add(geometry.box, material, x, y, z, width, height, depth, color);
    if (solid) collider(x, y, z, width, height, depth);
  }
  function freeAt(x, z, clearance = CLEARANCE, bodyHeight = 2) {
    const y = heightAt(x, z);
    if (y < 1.2 || Math.hypot(x, z) > 515) return false;
    if (Math.abs(heightAt(x + clearance, z) - y) > 0.55 || Math.abs(heightAt(x, z + clearance) - y) > 0.55 ||
        Math.abs(heightAt(x - clearance, z) - y) > 0.55 || Math.abs(heightAt(x, z - clearance) - y) > 0.55) return false;
    return !colliders.some(bounds => x + clearance > bounds.minX && x - clearance < bounds.maxX &&
      z + clearance > bounds.minZ && z - clearance < bounds.maxZ && y + bodyHeight > bounds.minY && y + 0.06 < bounds.maxY);
  }

  function makeBuilding(x, z, warehouse, blue, index) {
    const y = heightAt(x, z);
    const width = warehouse ? 21 : 14;
    const depth = warehouse ? 18 : 12;
    const wallHeight = warehouse ? 7 : 4.9;
    const doorWidth = warehouse ? 5 : 2.8;
    const doorHeight = warehouse ? 5 : 3.1;
    const tint = warehouse ? 0xb8bbae : PALETTE.plaster[index % PALETTE.plaster.length];
    const wallThickness = 0.35;
    box(x, y - 0.12, z, width, 0.24, depth, warehouse ? 0x939789 : 0xb7ae97, true);
    // Front AND rear doorways are empty volumes, bounded only by jambs and a lintel.
    for (const side of [-1, 1]) {
      const wallZ = z + side * depth / 2;
      const wingWidth = (width - doorWidth) / 2;
      for (const wing of [-1, 1]) {
        box(x + wing * (doorWidth + wingWidth) / 2, y + wallHeight / 2, wallZ,
          wingWidth, wallHeight, wallThickness, tint, true);
      }
      box(x, y + (wallHeight + doorHeight) / 2, wallZ, doorWidth, wallHeight - doorHeight, wallThickness, tint, true);
      for (const wing of [-1, 1]) box(x + wing * (doorWidth / 2 + 0.09), y + doorHeight / 2,
        wallZ + side * 0.08, 0.18, doorHeight, 0.43, PALETTE.trim, true);
      box(x, y + doorHeight + 0.07, wallZ, doorWidth + 0.36, 0.18, 0.44, PALETTE.trim, true);
      // Painted lintel stripe makes open entrances legible from a distance.
      box(x, y + doorHeight + 0.53, wallZ + side * 0.19, doorWidth + 1, 0.22, 0.035, blue ? PALETTE.blue : PALETTE.red);
    }
    // Windows have an actual opening and a thin, collidable glass pane, not a painted solid wall.
    const windowWidth = warehouse ? 5 : 3.4;
    const sill = warehouse ? 2.8 : 1.25;
    const windowHeight = warehouse ? 2 : 1.85;
    for (const side of [-1, 1]) {
      const wallX = x + side * width / 2;
      const wingDepth = (depth - windowWidth) / 2;
      for (const wing of [-1, 1]) box(wallX, y + wallHeight / 2, z + wing * (windowWidth + wingDepth) / 2,
        wallThickness, wallHeight, wingDepth, tint, true);
      box(wallX, y + sill / 2, z, wallThickness, sill, windowWidth, tint, true);
      const upper = wallHeight - sill - windowHeight;
      box(wallX, y + sill + windowHeight + upper / 2, z, wallThickness, upper, windowWidth, tint, true);
      box(wallX, y + sill + windowHeight / 2, z, 0.07, windowHeight, windowWidth, 0x668c96, true, materials.glass);
      box(wallX + side * 0.2, y + sill, z, 0.48, 0.15, windowWidth + 0.35, PALETTE.trim, true);
      box(wallX + side * 0.2, y + sill + windowHeight / 2, z, 0.12, windowHeight, 0.09, PALETTE.trim, true);
    }
    const roofWidth = width + 1.4;
    const roofDepth = depth + 1.4;
    const roofRise = warehouse ? 2.6 : 2.1;
    const roofColor = blue ? PALETTE.blue : PALETTE.red;
    batches.add(geometry.roof, materials.solid, x, y + wallHeight, z, roofWidth, roofRise, roofDepth, roofColor);
    // Tight stepped AABBs represent the solid roof/attic only; none spans the occupied room.
    const roofSlices = 12;
    for (let i = 0; i < roofSlices; i++) {
      const left = -roofWidth / 2 + i * roofWidth / roofSlices;
      const right = left + roofWidth / roofSlices;
      const nearRidge = Math.min(Math.abs(left), Math.abs(right));
      const thickness = roofRise * (1 - nearRidge / (roofWidth / 2));
      collider(x + (left + right) / 2, y + wallHeight + thickness / 2, z, roofWidth / roofSlices, thickness, roofDepth);
    }
    box(x, y + wallHeight + roofRise + 0.06, z, 0.18, 0.13, roofDepth + 0.1, roofColor, true);
    // Battens suggest tiled/corrugated roofs with no additional draw calls.
    for (let j = -4; j <= 4; j++) {
      const localX = j * roofWidth / 10;
      const roofY = y + wallHeight + roofRise * (1 - Math.abs(localX) / (roofWidth / 2));
      box(x + localX, roofY + 0.035, z, 0.07, 0.07, roofDepth, blue ? 0x4e7889 : 0xb95a42);
    }
    if (warehouse) {
      for (const side of [-1, 1]) for (const end of [-1, 1]) {
        box(x + side * width * 0.36, y + 1.1, z + end * depth * 0.3, 2.8, 2.2, 3.1, 0x9c8259, true);
        box(x + side * width * 0.36, y + 2.35, z + end * depth * 0.3, 2.6, 0.3, 3, 0x65553e, true);
      }
    } else {
      box(x - width * 0.3, y + 0.44, z + depth * 0.33, 2.3, 0.88, 1.2, 0x887359, true);
      box(x + width * 0.31, y + 0.65, z - depth * 0.3, 1.15, 1.3, 1.15, 0x8d9b91, true);
    }
    if (!warehouse) {
      const chimneyX = x - width * 0.27;
      box(chimneyX, y + wallHeight + 1.8, z - depth * 0.25, 0.8, 1.8, 0.8, 0x9e8065, true);
      box(chimneyX, y + wallHeight + 2.74, z - depth * 0.25, 1, 0.16, 1, 0x727364, true);
      for (const side of [-1, 1]) {
        // A dirt apron and planted corners frame each entrance, leaving its full passage empty.
        box(x, y + 0.025, z + side * (depth / 2 + 1.4), doorWidth + 1.8, 0.035, 2.8, 0xb4a98b);
        for (const wing of [-1, 1]) {
          const px = x + wing * (width / 2 - 1.4);
          const pz = z + side * (depth / 2 + 0.8);
          box(px, y + 0.24, pz, 1.6, 0.48, 1.1, 0x8f8065, true);
          batches.add(geometry.crown, materials.foliage, px, y + 0.62, pz, 0.92, 0.5, 0.65, 0x677e49);
        }
        box(x + side * (width / 2 + 0.23), y + sill + windowHeight + 0.12, z,
          0.3, 0.2, windowWidth + 0.35, PALETTE.trim, true);
        for (const end of [-1, 1]) box(x + side * (width / 2 + 0.24), y + sill + windowHeight / 2,
          z + end * (windowWidth / 2 + 0.42), 0.12, windowHeight + 0.2, 0.62, blue ? 0x587b85 : 0x8a5844, true);
      }
    }
    buildings.push({ x, z, width, depth });
    for (const offset of [-0.23, 0, 0.23]) lootSpawns.push({ x: x + width * offset, z });
  }

  function makeSettlements() {
    let index = 0;
    for (const location of LOCATIONS) {
      // Reserve the sign's entire footprint before placing houses, never across a road or doorway.
      let signPosition;
      for (const dz of [12, -12, 36, -36, 54, -54]) {
        for (const dx of [12, -12, 36, -36, 54, -54]) {
          const x = location.x + dx; const z = location.z + dz;
          if (Math.hypot(dx, dz) > location.radius - 9 || distanceToRoad(x, z) < 12 || !freeAt(x, z, 6, 6)) continue;
          signPosition = { x, z }; break;
        }
        if (signPosition) break;
      }
      if (!signPosition) throw new Error(`No clear roadside sign location at ${location.name}`);
      let count = 0;
      for (const dz of [-48, -24, 0, 24, 48]) for (const dx of [-48, -24, 0, 24, 48]) {
        const x = location.x + dx;
        const z = location.z + dz;
        const warehouse = ['harbor', 'depot'].includes(location.kind) && count < 3;
        const footprint = warehouse ? 14 : 10;
        if (Math.hypot(dx, dz) + footprint > location.radius - 14) continue;
        if (distanceToRoad(x, z) < footprint + 7.5) continue;
        if (Math.abs(x - signPosition.x) < footprint + 6 && Math.abs(z - signPosition.z) < footprint + 4) continue;
        if (location.kind === 'outpost' && Math.abs(dx) < 12 && Math.abs(dz + 22) < 14) continue;
        if (location.kind === 'coast' && Math.abs(dx - 31) < 13 && Math.abs(dz - 30) < 12) continue;
        if (FIELD_PLOTS.some(plot => Math.abs(x - plot.x) < plot.width / 2 + 10 && Math.abs(z - plot.z) < plot.depth / 2 + 9)) continue;
        makeBuilding(x, z, warehouse, index % 2 === 0, index++);
        count++;
      }
      makeSign(location, signPosition, root, resources, box);
      // Low bollards and supply stacks leave broad, unfenced routes through each square.
      const x = location.x - 10;
      const z = location.z + 10;
      if (distanceToRoad(x, z) > 8 && freeAt(x, z, 2)) {
        box(x, heightAt(x, z) + 0.65, z, 1.8, 1.3, 1.8, 0xa99164, true);
      }
    }
  }

  function makeBridges() {
    for (const bridge of BRIDGES) {
      const { x, z, width, length, height } = bridge;
      box(x, height - 0.5, z, width, 1, length, 0x94988c, true);
      for (const side of [-1, 1]) {
        const railX = x + side * (width / 2 - 0.22);
        box(railX, height + 0.67, z, 0.3, 0.28, length, 0x6d807d, true);
        box(railX, height + 1.25, z, 0.26, 0.16, length, 0x9baba1, true);
        for (let offset = -length / 2 + 2; offset < length / 2; offset += 5) {
          box(railX, height + 0.65, z + offset, 0.3, 1.3, 0.3, 0x82918a, true);
        }
      }
      for (const offset of [-27, 0, 27]) {
        for (const side of [-1, 1]) box(x + side * 4.2, 1.1, z + offset, 1.3, 10.8, 2.4, 0x868c81, true);
        box(x, height - 1.35, z + offset, width - 1, 0.8, 2.6, 0x7c857d, true);
      }
    }
  }

  function makeLandmarks() {
    // Harbor loading yard: stacked shipping containers, open gantry and water-facing mast.
    const harbor = LOCATIONS[0];
    for (let i = 0; i < 4; i++) {
      const x = harbor.x - 35 + i * 10;
      const z = harbor.z - 54;
      if (!freeAt(x, z, 4)) continue;
      const y = heightAt(x, z);
      box(x, y + 1.4, z, 7.6, 2.8, 3, i % 2 ? 0x497784 : 0xa76343, true);
      for (let stripe = -3; stripe <= 3; stripe++) box(x + stripe, y + 1.4, z + 1.53, 0.08, 2.55, 0.06, 0xc1b69c);
    }
    const craneX = harbor.x - 50;
    const craneZ = harbor.z + 5;
    const craneY = heightAt(craneX, craneZ);
    for (const side of [-1, 1]) box(craneX + side * 4, craneY + 8, craneZ, 0.8, 16, 0.8, 0xc09d4b, true);
    box(craneX, craneY + 16, craneZ, 16, 1, 1, 0xc09d4b, true);
    box(craneX + 7, craneY + 12, craneZ, 0.07, 7, 0.07, 0x6d7067, true);

    // The north ridge silhouette is an open steel radio tower, not an invisible solid block.
    const outpost = LOCATIONS[2];
    const towerX = outpost.x;
    const towerZ = outpost.z - 22;
    const towerY = heightAt(towerX, towerZ);
    for (const dx of [-2.6, 2.6]) for (const dz of [-2.6, 2.6]) box(towerX + dx, towerY + 15, towerZ + dz,
      0.4, 30, 0.4, 0x929b91, true);
    for (const level of [6, 14, 22, 29]) {
      box(towerX, towerY + level, towerZ, 6, 0.25, 6, 0x838f88, true);
    }
    box(towerX, towerY + 35, towerZ, 0.35, 12, 0.35, 0xb6b4a4, true);
    box(towerX, towerY + 39, towerZ, 3.2, 0.15, 0.15, 0xc5c7b9, true);

    for (const plot of FIELD_PLOTS) {
      const y = heightAt(plot.x, plot.z);
      box(plot.x, y - 0.055, plot.z, plot.width, 0.12, plot.depth, 0x897849);
      for (let row = -plot.width / 2 + 1; row < plot.width / 2; row += 2.4) {
        box(plot.x + row, y + 0.035, plot.z, 0.44, 0.05, plot.depth - 1, 0xa18a52);
        for (let col = -plot.depth / 2 + 1; col < plot.depth / 2; col += low ? 2.8 : 1.4) {
          batches.add(geometry.grass, materials.grass, plot.x + row, y + 0.07, plot.z + col, 0.95, 0.85, 0.95, 0xc1b36b, random() * Math.PI, 0, false);
        }
      }
    }
    // Coastal beacon: the only tall landmark in White Bay, with a clear route around its base.
    const bay = LOCATIONS[7];
    const bx = bay.x + 31; const bz = bay.z + 30; const by = heightAt(bx, bz);
    box(bx, by + 5, bz, 4.4, 10, 4.4, 0xe3d9bf, true);
    box(bx, by + 7, bz, 4.5, 1.2, 4.5, 0xb4543f, true);
    box(bx, by + 11, bz, 3.4, 2, 3.4, 0x789594, true, materials.glass);
    batches.add(geometry.roof, materials.solid, bx, by + 12, bz, 5.1, 1.6, 5.1, PALETTE.red);
    collider(bx, by + 12.8, bz, 5.1, 1.6, 5.1);
  }

  function makeVillageDetails() {
    const location = LOCATIONS.find(point => point.id === 'central-town');
    let decorated = 0;
    for (const dz of [-36, -12, 12, 36, 60]) for (const dx of [-60, -36, -12, 12, 36, 60]) {
      if (decorated >= 4) continue;
      const x = location.x + dx; const z = location.z + dz;
      if (Math.hypot(dx, dz) > location.radius - 18 || distanceToRoad(x, z) < 13 || !freeAt(x, z, 4.5, 6)) continue;
      if (buildings.some(building => Math.abs(x - building.x) < building.width / 2 + 6 &&
          Math.abs(z - building.z) < building.depth / 2 + 7)) continue;
      const y = heightAt(x, z);
      box(x, y + 0.025, z, 7, 0.035, 6, 0xb0aa91);
      if (decorated % 2 === 0) {
        // Open market awning; only the four legs and overhead roof collide.
        for (const side of [-1, 1]) for (const end of [-1, 1]) box(x + side * 2.8, y + 1.7, z + end * 2,
          0.13, 3.4, 0.13, 0x74634b, true);
        box(x, y + 3.4, z, 6.2, 0.18, 4.5, 0xd6be86, true);
        for (let stripe = -2; stripe <= 2; stripe++) box(x + stripe * 1.2, y + 3.51, z, 0.5, 0.035, 4.5, 0x607d72);
        box(x, y + 0.55, z - 1.5, 3.6, 1.1, 0.85, 0x958263, true);
      } else {
        box(x, y + 0.5, z, 3.4, 0.18, 1, 0x8b7755, true);
        box(x, y + 1.05, z - 0.4, 3.4, 0.8, 0.14, 0x8b7755, true);
        for (const side of [-1, 1]) box(x + side * 1.2, y + 0.24, z, 0.15, 0.48, 0.7, 0x4f5f57, true);
      }
      box(x + 3.1, y + 3.1, z + 2.4, 0.14, 6.2, 0.14, 0x54605b, true);
      box(x + 3.1, y + 6.25, z + 2.4, 0.8, 0.28, 0.65, 0xdedbb5, true);
      decorated++;
    }
  }

  function makeSpawns() {
    // Put the dressed central settlement first for the main-owned menu hero camera.
    // Deterministic lattice search, not random retries that can silently produce too few points.
    const central = LOCATIONS.find(location => location.id === 'central-town');
    for (const location of [central, ...LOCATIONS.filter(location => location !== central)]) {
      let spawns = 0;
      let loot = 0;
      for (let ring = 0; ring < 4; ring++) {
        const radius = 20 + ring * 11;
        for (let step = 0; step < 24; step++) {
          const angle = step * Math.PI / 12 + ring * 0.13;
          const x = location.x + Math.cos(angle) * radius;
          const z = location.z + Math.sin(angle) * radius;
          if (!freeAt(x, z)) continue;
          if (buildings.some(building => Math.abs(x - building.x) < building.width / 2 + 2 &&
              Math.abs(z - building.z) < building.depth / 2 + 2)) continue;
          if (spawnPoints.some(point => Math.hypot(point.x - x, point.z - z) < 9)) continue;
          if (spawns < 9) { spawnPoints.push({ x, z }); spawns++; }
          if (loot < 5 && lootSpawns.every(point => Math.hypot(point.x - x, point.z - z) > 4)) {
            lootSpawns.push({ x, z }); loot++;
          }
        }
      }
      if (spawns < 5) throw new Error(`Insufficient reachable spawn points at ${location.name}: ${spawns}`);
    }
  }

  function makeNature() {
    // Independent streams keep low-quality forests a strict subset and never move settlements/spawns.
    const natureRandom = createRandom(seed ^ 0x5f3759df);
    const reserved = [...spawnPoints, ...lootSpawns];
    function available(x, z, radius) {
      if (Math.hypot(x, z) > 530 || heightAt(x, z) < 4) return false;
      if (LOCATIONS.some(location => Math.hypot(x - location.x, z - location.z) < location.radius + 12)) return false;
      if (distanceToRoad(x, z) < radius + 9) return false;
      if (Math.abs(z - riverCenterAt(x)) < 32) return false;
      return reserved.every(point => Math.hypot(x - point.x, z - point.z) > radius + 3);
    }
    let trees = 0;
    for (let attempt = 0; attempt < 18000 && trees < TREE_COUNTS[quality]; attempt++) {
      const x = (natureRandom() - 0.5) * 1080;
      const z = (natureRandom() - 0.5) * 1080;
      const size = 0.8 + natureRandom() * 0.9;
      const pine = natureRandom() > 0.48;
      if (!available(x, z, 2)) continue;
      const y = heightAt(x, z);
      const trunkHeight = (pine ? 9 : 7) * size;
      const trunkRadius = 0.36 * size;
      batches.add(geometry.trunk, materials.solid, x, y + trunkHeight / 2 - 0.15, z,
        trunkRadius, trunkHeight, trunkRadius, PALETTE.trunk);
      collider(x, y + trunkHeight / 2 - 0.15, z, trunkRadius * 2, trunkHeight, trunkRadius * 2);
      const tint = PALETTE.leaves[trees % PALETTE.leaves.length];
      if (pine) {
        for (let layer = 0; layer < 3; layer++) batches.add(geometry.pine, materials.foliage,
          x, y + (5.8 + layer * 2) * size, z, (3.6 - layer * 0.7) * size, 5.7 * size, (3.6 - layer * 0.7) * size, tint);
      } else {
        batches.add(geometry.crown, materials.foliage, x, y + trunkHeight + size, z, 4.3 * size, 3.8 * size, 4.1 * size, tint);
        batches.add(geometry.crown, materials.foliage, x + 2 * size, y + trunkHeight - size, z + size,
          3.1 * size, 2.7 * size, 3.2 * size, tint);
      }
      trees++;
    }
    const rockRandom = createRandom(seed ^ 0x18ac732d);
    geometry.rock.computeBoundingBox();
    const rockBounds = geometry.rock.boundingBox;
    for (let i = 0; i < (low ? 150 : 340); i++) {
      const x = (rockRandom() - 0.5) * 1070;
      const z = (rockRandom() - 0.5) * 1070;
      const size = 1.2 + rockRandom() * 3.1;
      if (!available(x, z, size + 1)) continue;
      const y = heightAt(x, z);
      // Axis-aligned irregular rocks: their real geometry bounds define the collision proxy.
      const sy = size * 0.72;
      const sz = size * 0.85;
      batches.add(geometry.rock, materials.foliage, x, y + sy * 0.45, z, size, sy, sz, 0x8c8c78);
      const bounds = rockBounds;
      colliders.push({ minX: x + bounds.min.x * size, maxX: x + bounds.max.x * size,
        minY: y + sy * 0.45 + bounds.min.y * sy, maxY: y + sy * 0.45 + bounds.max.y * sy,
        minZ: z + bounds.min.z * sz, maxZ: z + bounds.max.z * sz });
    }
    const grassRandom = createRandom(seed ^ 0x7834fa1d);
    let grass = 0;
    for (let attempt = 0; attempt < 18000 && grass < GRASS_COUNTS[quality]; attempt++) {
      const x = (grassRandom() - 0.5) * 1080;
      const z = (grassRandom() - 0.5) * 1080;
      if (!available(x, z, 0.6)) continue;
      const size = 0.45 + grassRandom() * 0.75;
      batches.add(geometry.grass, materials.grass, x, heightAt(x, z) - 0.06, z,
        size * 1.6, size, size * 1.6, grass % 4 ? 0x83935a : 0xa8a370, grassRandom() * Math.PI, 0, false);
      grass++;
    }
  }

  function makeHorizon() {
    const horizonRandom = createRandom(seed ^ 0x31756abc);
    for (let i = 0; i < 26; i++) {
      const angle = i / 26 * Math.PI * 2;
      const radius = 970 + horizonRandom() * 310;
      const height = 25 + horizonRandom() * 58;
      batches.add(geometry.rock, materials.foliage, Math.cos(angle) * radius, -height * 0.38, Math.sin(angle) * radius,
        65 + horizonRandom() * 95, height, 60 + horizonRandom() * 90, 0x7e9290, horizonRandom() * 3, 0, false);
    }
    for (let i = 0; i < 23; i++) {
      const x = (horizonRandom() - 0.5) * 2100;
      const z = (horizonRandom() - 0.5) * 2100;
      const y = 240 + horizonRandom() * 110;
      for (let puff = 0; puff < 3; puff++) batches.add(geometry.crown, materials.cloud,
        x + puff * 28, y + puff % 2 * 7, z, 40 + horizonRandom() * 25, 9 + horizonRandom() * 8, 24, 0xe7eeeb, 0, 0, false);
    }
    // A few exposed coastal rocks anchor the water/land transition visually.
    for (let i = 0; i < 42; i++) {
      const angle = i / 42 * Math.PI * 2;
      const radius = coastRadiusAt(angle) + 10;
      const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
      batches.add(geometry.rock, materials.foliage, x, -0.8, z, 4.5, 3.2, 5.5, 0x8b9586, 0, 0, false);
      collider(x, -0.8, z, 9, 6.4, 11);
    }
  }

  let atmosphere;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    root.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
    atmosphere?.dispose();
    resources.dispose();
    root.clear();
  }
  // Cleanup on initialization failure is not a fallback: report the original integration error.
  try {
    makeTerrain(root, resources, low);
    makeRoads(root, resources);
    makeSettlements();
    makeBridges();
    makeLandmarks();
    makeVillageDetails();
    makeSpawns();
    makeNature();
    makeHorizon();
    if (lootSpawns.length < 80 || spawnPoints.length < 40) throw new Error('World requires at least 80 loot and 40 player spawns');
    for (const point of [...lootSpawns, ...spawnPoints]) {
      if (!freeAt(point.x, point.z)) throw new Error(`Obstructed world spawn at ${point.x}, ${point.z}`);
    }
    batches.flush();
    atmosphere = makeAtmosphere(scene, root, resources);
    scene.add(root);
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    size: MAP_SIZE,
    locations: LOCATIONS.map(({ id, name, x, z, radius, color }) => ({ id, name, x, z, radius, color })),
    lootSpawns,
    spawnPoints,
    colliders,
    heightAt,
    update(dt, elapsed) {
      if (disposed) return;
      if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(elapsed) || elapsed < 0) {
        throw new RangeError('World update requires finite, non-negative dt and elapsed');
      }
      atmosphere.update(elapsed);
    },
    dispose,
  };
}
