import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createSoldier} from '../src/models.js';

let count = 0, failed = 0;
function test(name, run) {
  count++;
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
const WEAPONS = ['m416', 'akm', 'ump45', 'kar98'];
const JOINT_COUNTS = {
  hips: 1, torso: 1, head: 1, 'weapon-mount': 1,
  'left-thigh': 1, 'right-thigh': 1, shin: 2, boot: 2,
  'left-arm': 1, 'right-arm': 1, forearm: 2,
  'support-hand': 1, 'trigger-hand': 1, parachute: 1,
};
const POSES = [
  ['standing', {}], ['running', {speed: 5.5}],
  ['crouching', {crouch: true}], ['crouch-running', {crouch: true, speed: 2}],
  ['prone', {prone: true}], ['prone-moving', {prone: true, speed: 0.8}],
  ['airborne', {airborne: true, speed: 3}],
  ['parachute', {airborne: true, parachute: true}],
  ['dead', {dead: true}],
  ['dead-airborne', {dead: true, airborne: true, parachute: true}],
];
function withSoldier(player, run) {
  const soldier = createSoldier({player});
  try { run(soldier); } finally { soldier.dispose(); }
}
function named(root, name) {
  const objects = [];
  root.traverse(object => { if (object.name === name) objects.push(object); });
  return objects;
}
function surfaces(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
function visibleMeshes(root) {
  const meshes = [];
  root.traverseVisible(object => {
    if (object.isMesh && surfaces(object).some(material => material.visible)) meshes.push(object);
  });
  return meshes;
}
function finiteArray(values, context) {
  assert.ok(Array.from(values).every(Number.isFinite), context + ' must contain only finite numbers');
}
// Box3.setFromObject also includes hidden guns/canopy. Transform actual visible
// vertices instead, so bounds cannot accidentally describe unequipped equipment.
function inspectVisible(root, context) {
  root.updateMatrixWorld(true);
  root.traverse(object => {
    finiteArray(object.matrix.elements, context + ' local matrix ' + object.name);
    finiteArray(object.matrixWorld.elements, context + ' world matrix ' + object.name);
  });
  const box = new THREE.Box3(), vertex = new THREE.Vector3();
  const meshes = visibleMeshes(root);
  let vertices = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    assert.ok(position && position.count > 0, context + ' visible mesh needs vertices: ' + mesh.name);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i);
      assert.ok(Number.isFinite(vertex.x) && Number.isFinite(vertex.y) && Number.isFinite(vertex.z),
        context + ' local vertex ' + mesh.name + ':' + i);
      vertex.applyMatrix4(mesh.matrixWorld);
      assert.ok(Number.isFinite(vertex.x) && Number.isFinite(vertex.y) && Number.isFinite(vertex.z),
        context + ' world vertex ' + mesh.name + ':' + i);
      box.expandByPoint(vertex);
      vertices++;
    }
  }
  assert.ok(vertices > 0 && !box.isEmpty(), context + ' must render nonempty geometry');
  return {box, meshes, height: box.max.y - box.min.y};
}
function settle(soldier, pose) {
  for (let frame = 0; frame < 120; frame++) soldier.update({dt: 1 / 60, ...pose});
}
function resources(root) {
  const meshes = new Map(), geometries = new Set(), materials = new Set();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const surface = surfaces(mesh);
    meshes.set(mesh, {geometry: mesh.geometry, materials: surface});
    geometries.add(mesh.geometry);
    surface.forEach(material => materials.add(material));
  });
  return {meshes, geometries, materials};
}
function assertResourcesUnchanged(root, before, context) {
  let meshCount = 0;
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    meshCount++;
    const original = before.meshes.get(mesh);
    assert.ok(original, context + ' must not add/replace meshes');
    assert.equal(mesh.geometry, original.geometry, context + ' must reuse geometry');
    const current = surfaces(mesh);
    assert.equal(current.length, original.materials.length, context + ' material count');
    current.forEach((material, i) => assert.equal(material, original.materials[i], context + ' must reuse material'));
  });
  assert.equal(meshCount, before.meshes.size, context + ' must retain hidden and visible meshes');
}
function assertWeaponVisibility(root, weapon, parachute = false) {
  const rendered = new Set();
  root.traverseVisible(object => rendered.add(object));
  for (const id of WEAPONS) {
    const guns = named(root, id);
    assert.equal(guns.length, 1, 'one persistent group per weapon: ' + id);
    const expected = weapon === id && !parachute;
    assert.equal(guns[0].visible, expected, id + ' visibility for ' + weapon);
    assert.equal(rendered.has(guns[0]), expected, id + ' effective visibility for ' + weapon);
    if (expected) assert.ok(visibleMeshes(guns[0]).length > 0, id + ' must retain rendered geometry after batching');
  }
}

for (const player of [false, true]) {
  const kind = player ? 'player' : 'NPC';
  test(kind + ' preserves factory interface and independently named joints', () => withSoldier(player, soldier => {
    assert.ok(soldier.root.isGroup);
    assert.equal(typeof soldier.update, 'function');
    assert.equal(typeof soldier.dispose, 'function');
    for (const [name, expected] of Object.entries(JOINT_COUNTS)) {
      const joints = named(soldier.root, name);
      assert.equal(joints.length, expected, name + ' count');
      for (const joint of joints) assert.ok(joint.isGroup, name + ' must remain a transform group');
    }
    for (const side of ['left', 'right']) {
      const thigh = soldier.root.getObjectByName(side + '-thigh');
      assert.ok(thigh.getObjectByName('shin')?.getObjectByName('boot'), side + ' leg hierarchy');
    }
  }));

  test(kind + ' standing visible geometry has floor origin and 1.70..1.80 m height', () => withSoldier(player, soldier => {
    soldier.update({dt: 0, weapon: 'm416'});
    const {box, height} = inspectVisible(soldier.root, kind + ' standing');
    assert.deepEqual(soldier.root.position.toArray(), [0, 0, 0]);
    assert.ok(Math.abs(box.min.y) <= 0.02, 'standing sole y=' + box.min.y + ' must be within 0.02 m of zero');
    assert.ok(height >= 1.70 && height <= 1.80, 'standing height=' + height + ' must be 1.70..1.80 m');
    assert.equal(soldier.root.getObjectByName('parachute').visible, false);
    console.log(`INFO ${kind} standing: sole=${box.min.y.toFixed(4)}m height=${height.toFixed(4)}m meshes=${visibleMeshes(soldier.root).length}`);
  }));

  test(kind + ' four weapons are mutually exclusive and null hides all guns', () => withSoldier(player, soldier => {
    for (const weapon of [...WEAPONS, null, ...WEAPONS.slice().reverse(), null]) {
      soldier.update({dt: 1 / 60, weapon});
      assertWeaponVisibility(soldier.root, weapon);
      inspectVisible(soldier.root, kind + ' weapon=' + weapon);
    }
    for (const weapon of [...WEAPONS, null]) {
      soldier.update({dt: 1 / 60, weapon, airborne: true, parachute: true});
      assertWeaponVisibility(soldier.root, weapon, true);
      assert.equal(soldier.root.getObjectByName('parachute').visible, true);
    }
    soldier.update({dt: 1 / 60, weapon: 'akm'});
    assertWeaponVisibility(soldier.root, 'akm');
    assert.equal(soldier.root.getObjectByName('parachute').visible, false);
  }));

  test(kind + ' settled crouch lowers rendered height', () => withSoldier(player, soldier => {
    const standing = inspectVisible(soldier.root, kind + ' standing');
    settle(soldier, {crouch: true});
    const crouching = inspectVisible(soldier.root, kind + ' crouching');
    assert.ok(crouching.box.max.y < standing.box.max.y, 'crouch must lower the rendered top');
    assert.ok(crouching.height < standing.height, 'crouch must reduce rendered vertical extent');
  }));

  for (const pose of ['prone', 'dead']) {
    test(kind + ' settled ' + pose + ' remains below 0.9 m', () => withSoldier(player, soldier => {
      settle(soldier, {[pose]: true});
      const {box, height} = inspectVisible(soldier.root, kind + ' ' + pose);
      console.log(`INFO ${kind} ${pose}: minY=${box.min.y.toFixed(4)}m maxY=${box.max.y.toFixed(4)}m height=${height.toFixed(4)}m`);
      assert.ok(box.max.y < 0.9, pose + ' visible top=' + box.max.y + ' must be below 0.9 m');
      assert.ok(height < 0.9, pose + ' visible vertical extent=' + height + ' must be below 0.9 m');
    }));
  }

  test(kind + ' every animation keeps matrices and visible vertices finite', () => withSoldier(player, soldier => {
    for (const [name, pose] of POSES) {
      for (let frame = 0; frame < 36; frame++) {
        soldier.update({dt: frame % 9 === 0 ? 0 : 1 / 30, yaw: Math.sin(frame * 0.4) * Math.PI,
          pitch: Math.cos(frame * 0.3) * 1.1, weapon: [...WEAPONS, null][frame % 5], ...pose});
        inspectVisible(soldier.root, kind + ' ' + name + ' frame=' + frame);
      }
    }
  }));

  test(kind + ' all weapons and poses stay within 30 visible meshes', () => withSoldier(player, soldier => {
    let maximum = 0;
    for (const [name, pose] of POSES) for (const weapon of [...WEAPONS, null]) {
      soldier.update({dt: 1 / 30, weapon, ...pose});
      const meshes = visibleMeshes(soldier.root).length;
      maximum = Math.max(maximum, meshes);
      assert.ok(meshes > 0 && meshes <= 30, `${kind} ${name} ${weapon}: ${meshes} visible meshes, budget 30`);
    }
    console.log(`INFO ${kind} maximum visible meshes=${maximum}`);
  }));

  test(kind + ' updates allocate no geometry/material and preserve moving joint pivots', () => withSoldier(player, soldier => {
    const original = resources(soldier.root);
    const joints = Object.keys(JOINT_COUNTS).filter(name => name !== 'parachute')
      .flatMap(name => named(soldier.root, name));
    soldier.root.updateMatrixWorld(true);
    const matrices = new Map(joints.map(joint => [joint, joint.matrix.clone()]));
    const changed = new Set();
    // Three.js resource ids are monotonic. Sentinels detect even transient,
    // unattached geometry/material allocations, unlike scene traversal alone.
    const beforeGeometry = new THREE.BufferGeometry(), beforeMaterial = new THREE.MeshBasicMaterial();
    let afterGeometry, afterMaterial;
    try {
      for (const [name, pose] of POSES) for (let frame = 0; frame < 12; frame++) {
        soldier.update({dt: 1 / 30, pitch: Math.sin(frame * 0.6), weapon: [...WEAPONS, null][frame % 5], ...pose});
        soldier.root.updateMatrixWorld(true);
        assertResourcesUnchanged(soldier.root, original, kind + ' ' + name + ' frame=' + frame);
        for (const joint of joints) if (!joint.matrix.equals(matrices.get(joint))) changed.add(joint);
      }
      afterGeometry = new THREE.BufferGeometry();
      afterMaterial = new THREE.MeshBasicMaterial();
      assert.equal(afterGeometry.id, beforeGeometry.id + 1, 'update must not construct any BufferGeometry');
      assert.equal(afterMaterial.id, beforeMaterial.id + 1, 'update must not construct any Material');
      for (const joint of joints) assert.ok(changed.has(joint), joint.name + ' local joint must still animate after rigid batching');
    } finally {
      beforeGeometry.dispose(); beforeMaterial.dispose();
      afterGeometry?.dispose(); afterMaterial?.dispose();
    }
  }));
}

for (const [firstPlayer, secondPlayer] of [[false, false], [true, true], [true, false], [false, true]]) {
  test(`resource isolation/dispose (${firstPlayer ? 'player' : 'NPC'} -> ${secondPlayer ? 'player' : 'NPC'})`, () => {
    const first = createSoldier({player: firstPlayer}), second = createSoldier({player: secondPlayer});
    try {
      const a = resources(first.root), b = resources(second.root);
      for (const geometry of a.geometries) assert.ok(!b.geometries.has(geometry), 'instances cannot share disposable geometry');
      for (const material of a.materials) assert.ok(!b.materials.has(material), 'instances cannot share disposable material');
      const firstEvents = new Map(), secondEvents = new Map();
      for (const resource of [...a.geometries, ...a.materials]) {
        firstEvents.set(resource, 0);
        resource.addEventListener('dispose', () => firstEvents.set(resource, firstEvents.get(resource) + 1));
      }
      for (const resource of [...b.geometries, ...b.materials]) {
        secondEvents.set(resource, 0);
        resource.addEventListener('dispose', () => secondEvents.set(resource, secondEvents.get(resource) + 1));
      }
      const scene = new THREE.Group();
      scene.add(first.root, second.root);
      first.dispose(); first.dispose();
      assert.equal(first.root.parent, null, 'dispose detaches the actor');
      assert.equal(second.root.parent, scene, 'other actor must remain attached');
      for (const calls of firstEvents.values()) assert.equal(calls, 1, 'each owned resource disposed exactly once');
      for (const calls of secondEvents.values()) assert.equal(calls, 0, 'disposing one actor must not dispose another');
      assert.throws(() => first.update({dt: 1 / 60}), /disposed/i);
      for (const weapon of [...WEAPONS, null]) {
        second.update({dt: 1 / 30, speed: 3, weapon});
        assertWeaponVisibility(second.root, weapon);
        inspectVisible(second.root, 'surviving actor ' + weapon);
        assertResourcesUnchanged(second.root, b, 'surviving actor');
      }
      second.dispose(); second.dispose();
      for (const calls of secondEvents.values()) assert.equal(calls, 1, 'survivor resources disposed exactly once');
      assert.throws(() => second.update({dt: 1 / 60}), /disposed/i);
    } finally { first.dispose(); second.dispose(); }
  });
}
console.log(`${count - failed}/${count} soldier model tests passed`);
process.exitCode = failed ? 1 : 0;
