import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {prepareTacticalSoldiers, createTacticalSoldier, disposeTacticalSoldiers} from '../src/tactical-soldier.js';
import {makeTacticalAssets} from '../tools/tactical-assets.mjs';

// node tests/tactical-soldiers.mjs: CPU-only, actual skinning, no DOM/GPU/network.
if (!globalThis.ProgressEvent) globalThis.ProgressEvent = class ProgressEvent extends Event {
  constructor(type, init = {}) { super(type); Object.assign(this, init); }
};
const WEAPONS = ['m416', 'akm', 'ump45', 'kar98'];
const POSES = [
  ['idle', {}], ['walk', {speed: 2}], ['run', {speed: 5.5}], ['crouch', {crouch: true}],
  ['crouch-walk', {crouch: true, speed: 2}], ['prone', {prone: true}], ['prone-moving', {prone: true, speed: .8}],
  ['airborne', {airborne: true, speed: 3}], ['parachute', {airborne: true, parachute: true}],
  ['dead', {dead: true}], ['dead-airborne', {dead: true, airborne: true, parachute: true}],
];
const live = new Set();
const boundariesOnly = process.argv.includes('--boundaries-only');
let count = 0, failed = 0;
async function test(name, run) {
  if (boundariesOnly && !name.startsWith('boundary:') && !name.startsWith('offline ')) return false;
  count++;
  try { await run(); console.log('PASS ' + name); return true; }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); return false; }
}
function create(options = {}) { const actor = createTacticalSoldier(options); live.add(actor); return actor; }
function release(actor) { actor.dispose(); live.delete(actor); }
async function withActor(player, run) {
  const actor = create({player}); try { await run(actor); } finally { release(actor); }
}
const materials = mesh => [mesh.material].flat().filter(Boolean);
function resources(root) {
  const meshes = new Map(), geometries = new Set(), surfaces = new Set(), textures = new Set();
  const bones = new Set(), skins = new Set(), skeletons = new Set();
  root.traverse(o => {
    if (o.isBone) bones.add(o);
    if (!o.isMesh) return;
    const surface = materials(o);
    meshes.set(o, {geometry: o.geometry, materials: surface}); geometries.add(o.geometry);
    for (const m of surface) { surfaces.add(m); for (const v of Object.values(m)) if (v?.isTexture) textures.add(v); }
    if (o.isSkinnedMesh) { skins.add(o); skeletons.add(o.skeleton); }
  });
  return {meshes, geometries, materials: surfaces, textures, bones, skins, skeletons};
}
function finite(values, context) { assert.ok(Array.from(values).every(Number.isFinite), context + ' must be finite'); }
function matrices(actor, context) {
  actor.root.updateMatrixWorld(true);
  for (const s of resources(actor.root).skeletons) { s.update(); finite(s.boneMatrices, context + ' skin matrices'); }
  actor.root.traverse(o => {
    finite(o.matrix.elements, context + ' local ' + o.name); finite(o.matrixWorld.elements, context + ' world ' + o.name);
    if (o.isBone) assert.ok(Math.abs(o.quaternion.length() - 1) < 1e-4, context + ' quaternion ' + o.name);
  });
}
function visibleMeshes(root) {
  const result = []; root.traverseVisible(o => {
    if (o.isMesh && materials(o).some(m => m.visible)) result.push(o);
  }); return result;
}
function sample(actor, context = 'sample') {
  matrices(actor, context);
  const box = new THREE.Box3(), bodyBox = new THREE.Box3(), v = new THREE.Vector3(), local = [];
  let bodyCount = 0;
  for (const mesh of visibleMeshes(actor.root)) {
    const p = mesh.geometry.getAttribute('position'); assert.ok(p?.count > 0, context + ' mesh ' + mesh.name);
    for (let i = 0; i < p.count; i++) {
      // Deliberately NOT fromBufferAttribute: that ignores weighted deformation.
      mesh.getVertexPosition(i, v); finite(v.toArray(), context + ' deformed local vertex');
      if (mesh === actor.body && i % 41 === 0) local.push(v.x, v.y, v.z);
      v.applyMatrix4(mesh.matrixWorld); finite(v.toArray(), context + ' deformed world vertex'); box.expandByPoint(v);
      if (mesh === actor.body) { bodyBox.expandByPoint(v); bodyCount++; }
    }
  }
  assert.ok(!box.isEmpty() && bodyCount >= 7000, context + ' actually renders weighted body');
  return {box, bodyBox, local, hipY: actor.bones.get('pelvis').matrixWorld.elements[13]};
}
function floorSample(actor, context) {
  matrices(actor, context);
  const v = new THREE.Vector3(); let minY = Infinity, bodyMinY = Infinity, bodyCount = 0, culprit;
  for (const mesh of visibleMeshes(actor.root)) {
    const count = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z), context + ' actual visible vertex finite');
      if (mesh === actor.body) { bodyMinY = Math.min(bodyMinY, v.y); bodyCount++; }
      if (v.y < minY) { minY = v.y; culprit = {mesh: mesh.name, vertex: i, skinned: !!mesh.isSkinnedMesh}; }
    }
  }
  assert.ok(bodyCount >= 7000, context + ' actual weighted body visible');
  return {minY, bodyMinY, culprit};
}
function reportFloors(label, records) {
  const invalid = records.filter(r => r.minY < -.06), worst = records.reduce((a, b) => !a || b.minY < a.minY ? b : a, null);
  console.log('BOUNDARY_SUMMARY ' + JSON.stringify({label, cases: records.length, failingCases: invalid.length, worst}));
  for (const record of invalid) console.log('BOUNDARY_FAIL ' + JSON.stringify({label, ...record}));
  assert.equal(invalid.length, 0, `${label}: ${invalid.length}/${records.length} cases below -.06; worst=${JSON.stringify(worst)}`);
}
function delta(a, b) {
  assert.equal(a.length, b.length); let result = 0;
  for (let i = 0; i < a.length; i++) result = Math.max(result, Math.abs(a[i] - b[i])); return result;
}
function settle(actor, pose = {}, frames = 120) {
  for (let i = 0; i < frames; i++) actor.update({dt: 1 / 60, ...pose});
}
function restBones(actor) {
  return new Map([...actor.bones].map(([name, b]) => [name, {bone: b, parent: b.parent, p: b.position.toArray(), s: b.scale.toArray()}]));
}
function lengths(actor, rest, context) {
  assert.equal(actor.bones.size, rest.size);
  for (const [name, initial] of rest) {
    const b = actor.bones.get(name); assert.equal(b, initial.bone); assert.equal(b.parent, initial.parent);
    assert.ok(delta(b.scale.toArray(), initial.s) < 1e-7, context + ' IK must not scale/stretch ' + name);
    if (name !== 'pelvis') assert.ok(delta(b.position.toArray(), initial.p) < 1e-6,
      context + ' non-pelvis offset/length unchanged ' + name);
  }
}
function unchanged(root, before, context) {
  const after = resources(root); assert.equal(after.meshes.size, before.meshes.size, context + ' mesh count');
  for (const [mesh, initial] of before.meshes) {
    assert.ok(after.meshes.has(mesh)); assert.equal(mesh.geometry, initial.geometry, context + ' geometry');
    const current = materials(mesh); assert.equal(current.length, initial.materials.length);
    current.forEach((m, i) => assert.equal(m, initial.materials[i], context + ' material'));
  }
}
function shared(a, b, context) {
  for (const key of ['geometries', 'materials', 'textures']) {
    assert.equal(a[key].size, b[key].size, context + ' shared ' + key + ' count');
    for (const value of a[key]) assert.ok(b[key].has(value), context + ' shares ' + key + ', not cloned');
  }
}
function independent(first, second, context) {
  const a = resources(first.root), b = resources(second.root);
  assert.notEqual(first.root, second.root); assert.notEqual(first.body, second.body); assert.notEqual(first.bones, second.bones);
  for (const key of ['bones', 'skins', 'skeletons']) for (const v of a[key]) assert.ok(!b[key].has(v), context + ' own ' + key);
  for (const skin of [...a.skins, ...b.skins]) {
    const owned = a.skins.has(skin) ? a : b;
    for (const bone of skin.skeleton.bones) assert.ok(owned.bones.has(bone), context + ' mixer/skin binds own ' + bone.name);
  }
  for (const x of a.skeletons) for (const y of b.skeletons) {
    assert.notEqual(x.boneMatrices, y.boneMatrices, context + ' mutable bone arrays');
    if (x.boneTexture && y.boneTexture) {
      assert.notEqual(x.boneTexture, y.boneTexture, context + ' GPU bone texture');
      assert.notEqual(x.boneTexture.image.data, y.boneTexture.image.data, context + ' texture data');
    }
  }
  shared(a, b, context); return {a, b};
}
function named(root, name) { const result = []; root.traverse(o => { if (o.name === name) result.push(o); }); return result; }
function guns(root, weapon, hide = false) {
  const visible = new Set(); root.traverseVisible(o => visible.add(o));
  for (const id of WEAPONS) {
    const matches = named(root, id); assert.equal(matches.length, 1, 'one persistent gun ' + id);
    const expected = weapon === id && !hide;
    assert.equal(matches[0].visible, expected, id + ' visibility'); assert.equal(visible.has(matches[0]), expected, id + ' effective visibility');
    if (expected) assert.ok(visibleMeshes(matches[0]).length > 0, id + ' real geometry');
  }
}
function canopy(root, expected) {
  const matches = named(root, 'parachute'); assert.equal(matches.length, 1); assert.equal(matches[0].visible, expected);
  if (expected) assert.ok(visibleMeshes(matches[0]).length > 0, 'real named canopy/lines');
}
function observe(values) {
  const counts = new Map(), listeners = new Map();
  for (const r of new Set(values)) {
    counts.set(r, 0); const fn = () => counts.set(r, counts.get(r) + 1);
    r.addEventListener('dispose', fn); listeners.set(r, fn);
  }
  return {
    check(n, context) { for (const [r, calls] of counts) assert.equal(calls, n, context + ' ' + r.type); },
    remove() { for (const [r, fn] of listeners) r.removeEventListener('dispose', fn); },
  };
}
function boneTextures(actor) {
  const result = new Set();
  for (const s of resources(actor.root).skeletons) {
    s.computeBoneTexture(); assert.ok(s.boneTexture?.isDataTexture); result.add(s.boneTexture);
  }
  assert.ok(result.size > 0, 'non-vacuous bone texture check'); return result;
}
function sentinels() {
  const g = new THREE.BufferGeometry(), m = new THREE.MeshBasicMaterial();
  return {
    check(context) {
      const nextG = new THREE.BufferGeometry(), nextM = new THREE.MeshBasicMaterial();
      try {
        const failures = [];
        if (nextG.id !== g.id + 1) failures.push(`${context}: BufferGeometry allocated ${nextG.id - g.id - 1} (expected id ${g.id + 1}, got ${nextG.id})`);
        if (nextM.id !== m.id + 1) failures.push(`${context}: Material allocated ${nextM.id - m.id - 1} (expected id ${m.id + 1}, got ${nextM.id})`);
        assert.equal(failures.length, 0, failures.join('\n'));
      } finally { nextG.dispose(); nextM.dispose(); }
    },
    dispose() { g.dispose(); m.dispose(); },
  };
}
async function main() {
  await test('actual Game source contract: preloaded tactical factory for menu/player/NPC and full visual state', async () => {
    const source = await readFile(new URL('../src/game.js', import.meta.url), 'utf8');
    assert.match(source, /import\s*\{\s*createTacticalSoldier\s+as\s+createSoldier\s*,\s*prepareTacticalSoldiers\s*\}\s*from\s*['"]\.\/tactical-soldier\.js['"]/);
    const oldImport = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/models\.js['"]/);
    assert.ok(oldImport); assert.doesNotMatch(oldImport[1], /\bcreateSoldier\b/, 'old segmented factory cannot be imported');
    const preload = source.indexOf('await prepareTacticalSoldiers(tacticalAssets)'), menu = source.indexOf('this.menuHero=createSoldier(');
    assert.ok(preload >= 0 && menu > preload, 'preload before menu or match actor creation');
    const actorMethod = source.match(/createActor\(isPlayer,id,position\)\s*\{([\s\S]*?)\n\s*\}/)?.[1];
    assert.ok(actorMethod); assert.match(actorMethod, /const model=createSoldier\(\{[^\n]*player:isPlayer\}\)/);
    assert.match(source, /this\.player=this\.createActor\(true,/); assert.match(source, /const bot=this\.createActor\(false,/);
    const visualSection = source.match(/updateVisuals\(dt\)\s*\{([\s\S]*?)this\.updateCamera\(dt\)/)?.[1]; assert.ok(visualSection, 'Game updateVisuals actor-update section');
    const visuals = visualSection.match(/actor\.model\.update\(\{([^\n]+)\}\)/)?.[1]; assert.ok(visuals);
    for (const field of ['dt:animDt', 'speed:actor.speed', 'yaw:actor.yaw', 'pitch:actor.pitch', 'crouch:actor.crouch', 'prone:actor.prone', 'parachute:actor.chute', 'dead:!actor.alive']) assert.ok(visuals.includes(field), 'Game passes ' + field);
    assert.ok(visuals.includes("airborne:actor.phase==='parachute'")); assert.ok(visuals.includes('distance:actor.isPlayer?0:dist(actor,p)'));
    assert.ok(visuals.includes('weapon:actor.inventory.slots[actor.inventory.active]?.id||null'));
  });
  let payload, prepared;
  const originalFetch = globalThis.fetch; let networkAttempts = 0;
  globalThis.fetch = async (input, ...args) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https?:/i.test(url)) { networkAttempts++; throw new Error('Tests forbid external asset loading: ' + url); }
    return originalFetch(input, ...args);
  };
  try {
    prepared = await test('offline CC0 pre-baked payload prepares without DOM/GPU/network', async () => {
      payload = await makeTacticalAssets({textures: false}); assert.ok(payload && typeof payload === 'object');
      await prepareTacticalSoldiers(payload); assert.equal(networkAttempts, 0);
    });
  } finally { globalThis.fetch = originalFetch; }
  if (!prepared) return;
  // Offline images are omitted. Real shared DataTexture makes resource disposal
  // non-vacuous; browser source PNG decoding is covered separately in Chrome.
  const fixtureActor = create(), fixture = new THREE.DataTexture(new Uint8Array([72, 80, 68, 255]), 1, 1);
  const fixtureMaterial = materials(fixtureActor.body)[0]; assert.equal(fixtureMaterial.map, null);
  fixtureMaterial.map = fixture; fixture.needsUpdate = true; release(fixtureActor);
  for (const player of [false, true]) {
    const kind = player ? 'player' : 'NPC';
    await test(kind + ' API/65 owned bones/three skins/>=7000 weighted authored vertices', () => withActor(player, actor => {
      assert.ok(actor.root.isGroup); assert.equal(typeof actor.update, 'function'); assert.equal(typeof actor.dispose, 'function');
      assert.ok(actor.body?.isSkinnedMesh); assert.ok(actor.bones instanceof Map); assert.equal(actor.bones.size, 65);
      const owned = resources(actor.root); assert.equal(owned.bones.size, 65); assert.equal(owned.skins.size, 3);
      assert.ok(owned.textures.has(fixture), 'shared texture fixture reused');
      const p = actor.body.geometry.attributes.position; assert.ok(p.count >= 7000); assert.ok(actor.body.geometry.index?.count > p.count);
      for (const skin of owned.skins) {
        const p = skin.geometry.attributes.position, w = skin.geometry.attributes.skinWeight, j = skin.geometry.attributes.skinIndex;
        assert.equal(w?.count, p.count); assert.equal(j?.count, p.count); assert.equal(w.itemSize, 4); assert.equal(j.itemSize, 4);
        for (let i = 0; i < p.count; i++) {
          let total = 0;
          for (let c = 0; c < 4; c++) {
            const weight = w.getComponent(i, c), index = j.getComponent(i, c);
            assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 1);
            assert.ok(Number.isInteger(index) && index >= 0 && index < skin.skeleton.bones.length); total += weight;
          }
          assert.ok(Math.abs(total - 1) < 1e-4, 'normalized weights ' + skin.name + ':' + i);
        }
        for (const bone of skin.skeleton.bones) assert.equal(actor.bones.get(bone.name), bone);
      }
    }));
    await test(kind + ' origin/yaw zero faces -Z, standing soles +/-.04/top1.65..1.85', () => withActor(player, actor => {
      actor.update({dt: 0}); assert.deepEqual(actor.root.position.toArray(), [0, 0, 0]); assert.equal(actor.root.rotation.y, 0);
      actor.root.updateMatrixWorld(true); const forward = new THREE.Vector3(), ankle = new THREE.Vector3(), toe = new THREE.Vector3();
      for (const side of ['l', 'r']) {
        actor.bones.get('foot_' + side).getWorldPosition(ankle); actor.bones.get('ball_' + side).getWorldPosition(toe); forward.add(toe.sub(ankle));
      }
      forward.y = 0; assert.ok(forward.length() > .01 && forward.normalize().z < -.8, 'authored feet face game -Z');
      for (let phase = 0; phase < 4; phase++) {
        if (phase) settle(actor, {}, 30); const s = sample(actor, kind + ' standing ' + phase);
        assert.ok(Math.abs(s.bodyBox.min.y) <= .04, 'weighted sole=' + s.bodyBox.min.y);
        assert.ok(Math.abs(s.box.min.y) <= .04, 'visible floor=' + s.box.min.y);
        assert.ok(s.box.max.y >= 1.65 && s.box.max.y <= 1.85, 'visible top=' + s.box.max.y);
      }
      guns(actor.root, 'm416'); canopy(actor.root, false);
    }));
    for (const [name, pose, temporalThreshold] of [
      ['idle', {}, .003], ['walk', {speed: 2}, .02], ['run', {speed: 5.5}, .02],
      ['crouch', {crouch: true}, .003], ['crouch-walk', {crouch: true, speed: 2}, .02],
    ]) await test(kind + ' ' + name + ' actual skin deformation and over-time motion', () => withActor(player, actor => {
      actor.update({dt: 0, weapon: null}); const rest = sample(actor), original = restBones(actor);
      settle(actor, {...pose, weapon: null}, 66); const a = sample(actor);
      settle(actor, {...pose, weapon: null}, 21); const b = sample(actor);
      const deformation = Math.max(delta(a.local, rest.local), delta(b.local, rest.local)), temporal = delta(a.local, b.local);
      console.log(`INFO ${kind} ${name}: deformation=${deformation.toFixed(5)} temporal=${temporal.toFixed(5)}`);
      assert.ok(deformation > (name === 'idle' ? .003 : .03), 'real weighted deformation=' + deformation);
      assert.ok(temporal > temporalThreshold, 'temporal=' + temporal + ' threshold=' + temporalThreshold); lengths(actor, original, name);
      if (name === 'walk' || name === 'run') for (const s of [a, b]) assert.ok(Math.abs(s.bodyBox.min.y) <= .04, 'contact=' + s.bodyBox.min.y);
    }));
    await test(kind + ' settled crouch real pelvis/silhouette descends >=.25m', () => withActor(player, actor => {
      settle(actor); const standing = sample(actor); settle(actor, {crouch: true}); const crouch = sample(actor);
      assert.ok(crouch.hipY < standing.hipY - .25); assert.ok(crouch.box.max.y < standing.box.max.y - .25);
      assert.ok(crouch.bodyBox.max.y < standing.bodyBox.max.y - .25); assert.ok(crouch.box.min.y >= -.06 && crouch.box.min.y <= .10);
    }));
    for (const pose of ['prone', 'dead']) await test(kind + ' settled ' + pose + ' top<.9/floor>=-.06', () => withActor(player, actor => {
      const problems = [];
      for (const weapon of [...WEAPONS, null]) {
        settle(actor, {[pose]: true, weapon}); const s = sample(actor);
        console.log(`INFO ${kind} ${pose}/${weapon}: minY=${s.box.min.y.toFixed(5)} maxY=${s.box.max.y.toFixed(5)} bodyMinY=${s.bodyBox.min.y.toFixed(5)} bodyMaxY=${s.bodyBox.max.y.toFixed(5)}`);
        if (s.box.max.y >= .9) problems.push(`${weapon}: visible top=${s.box.max.y} (must be <.9)`);
        if (s.box.min.y < -.06) problems.push(`${weapon}: visible floor=${s.box.min.y} (must be >=-.06)`);
        if (s.bodyBox.max.y >= .9 || s.bodyBox.min.y < -.06) problems.push(`${weapon}: actual weighted body [${s.bodyBox.min.y}, ${s.bodyBox.max.y}]`);
      }
      assert.equal(problems.length, 0, problems.join('\n'));
    }));
    await test(kind + ' four guns exclusive/null-hidden/para-hidden and real named canopy', () => withActor(player, actor => {
      for (const weapon of [...WEAPONS, null, ...WEAPONS.slice().reverse(), null]) {
        actor.update({dt: .016, weapon}); guns(actor.root, weapon); canopy(actor.root, false);
      }
      for (const weapon of [...WEAPONS, null]) {
        actor.update({dt: .016, weapon, airborne: true, parachute: true}); guns(actor.root, weapon, true); canopy(actor.root, true); sample(actor);
      }
      actor.update({dt: .016, weapon: 'akm'}); guns(actor.root, 'akm'); canopy(actor.root, false);
      actor.update({dt: .016, dead: true, airborne: true, parachute: true}); canopy(actor.root, false);
    }));
    await test(kind + ' armed varied pitch/speed/distance/repeated poses finite; no bone stretching/update allocation', () => withActor(player, actor => {
      const original = restBones(actor), owned = resources(actor.root), positions = actor.body.geometry.attributes.position.array.slice();
      const weights = actor.body.geometry.attributes.skinWeight.array.slice(), guard = sentinels(), problems = new Set();
      try {
        for (let cycle = 0; cycle < 3; cycle++) for (const [name, pose] of POSES) for (let frame = 0; frame < 12; frame++) {
          const weapon = [...WEAPONS, null][(frame + cycle) % 5], yaw = Math.sin(frame * .4) * Math.PI;
          try {
            actor.update({dt: frame % 7 === 0 ? 0 : 1 / 30, speed: [-2, 0, 2, 5.5, 8][frame % 5], yaw,
              pitch: [-1.1, -.55, 0, .55, 1.1][frame % 5], distance: [0, 25, 100, 160][frame % 4], ...pose, weapon});
            assert.equal(actor.root.rotation.y, yaw); unchanged(actor.root, owned, name); lengths(actor, original, name);
            sample(actor, kind + '/' + name + '/' + cycle + '/' + frame); guns(actor.root, weapon, !!pose.parachute); canopy(actor.root, !!pose.parachute && !pose.dead);
          } catch (error) { problems.add(`${name}: ${error.message}`); }
        }
        try { guard.check('update'); } catch (error) { problems.add(error.message); }
        assert.deepEqual(actor.body.geometry.attributes.position.array, positions); assert.deepEqual(actor.body.geometry.attributes.skinWeight.array, weights);
        assert.equal(problems.size, 0, [...problems].join('\n'));
      } finally { guard.dispose(); }
    }));
    await test(kind + ' armed pitch/moving speed change actual body skin', () => withActor(player, actor => {
      const states = [];
      for (const speed of [0, 2, 5.5]) for (const pitch of [-.75, 0, .75]) { settle(actor, {speed, pitch}, 48); states.push(sample(actor)); }
      for (let offset = 0; offset < 9; offset += 3) assert.ok(delta(states[offset].local, states[offset + 2].local) > .03, 'aim pitch deforms skin');
      assert.ok(delta(states[1].local, states[7].local) > .03, 'armed running deforms skin');
      settle(actor, {speed: 5.5, pitch: .5}, 21); const a = sample(actor); settle(actor, {speed: 5.5, pitch: .5}, 21);
      assert.ok(delta(a.local, sample(actor).local) > .02, 'armed run changes over time');
    }));
    await test(kind + ' invalid numerics/unknown gun/disposed update reject', () => withActor(player, actor => {
      for (const field of ['dt', 'speed', 'yaw', 'pitch', 'distance']) for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => actor.update({dt: .016, [field]: value}), field);
      assert.throws(() => actor.update({dt: -.01})); assert.throws(() => actor.update({dt: .016, weapon: 'unknown'}));
      release(actor); release(actor); assert.throws(() => actor.update({dt: .016}), /disposed/i);
    }));
  }
  await test('boundary: settled stationary/moving prone+crouch+death, all pitches/guns visible floor>=-.06', async () => {
    const records = [], poses = [
      ['prone', {prone: true}], ['prone-moving', {prone: true, speed: .8}],
      ['crouch', {crouch: true}], ['crouch-moving', {crouch: true, speed: 2}],
      ['death', {dead: true}], ['death-moving', {dead: true, speed: 2}],
    ];
    for (const player of [false, true]) await withActor(player, actor => {
      for (const [poseIndex, [pose, state]] of poses.entries()) for (const [pitchIndex, pitch] of [-1.1, 0, 1.1].entries()) for (const [gunIndex, weapon] of [...WEAPONS, null].entries()) {
        const context = `${player ? 'player' : 'NPC'}/${pose}/${weapon}/pitch${pitch}`;
        settle(actor, {...state, pitch, weapon}); let worst;
        for (let frame = 0; frame < 12; frame++) {
          if (frame) actor.update({dt: 1 / 60, ...state, pitch, weapon});
          const floor = floorSample(actor, context);
          if (!worst || floor.minY < worst.minY) worst = {...floor, frame};
        }
        records.push({kind: player ? 'player' : 'NPC', pose, poseIndex, pitch, pitchIndex, weapon, gunIndex, ...worst});
      }
    });
    reportFloors('settled floor (180 cases x12 consecutive samples)', records);
  });
  await test('boundary: all posture transitions, each 1/60 frame through .16s, all guns visible floor>=-.06', async () => {
    const records = [];
    for (const player of [false, true]) await withActor(player, actor => {
      for (const [fromIndex, [from, initial]] of POSES.entries()) for (const [toIndex, [to, target]] of POSES.entries()) {
        if (fromIndex === toIndex) continue;
        for (const [gunIndex, weapon] of [...WEAPONS, null].entries()) {
          const pitch = 0, context = `${player ? 'player' : 'NPC'}/${from}->${to}/${weapon}/pitch${pitch}`;
          settle(actor, {...initial, pitch, weapon}); let worst = {...floorSample(actor, context), frame: 0}, failingFrames = worst.minY < -.06 ? 1 : 0;
          // Ten equal 1/60 steps reach .1667s: covers every frame of the .16s
          // crossfade and the first fully settled target frame, never a time jump.
          for (let frame = 1; frame <= 10; frame++) {
            actor.update({dt: 1 / 60, ...target, pitch, weapon}); const floor = floorSample(actor, context);
            if (floor.minY < -.06) failingFrames++;
            if (floor.minY < worst.minY) worst = {...floor, frame};
          }
          records.push({kind: player ? 'player' : 'NPC', from, fromIndex, to, toIndex, pitch, pitchIndex: 1, weapon, gunIndex, failingFrames, ...worst});
        }
      }
    });
    reportFloors('crossfade floor (1100 directed transitions x11 samples incl baseline, neutral pitch)', records);
  });
  for (const [firstPlayer, secondPlayer] of [[false, false], [true, true], [true, false], [false, true]]) {
    await test(`shared assets/independent skin+mixer+disposal (${firstPlayer}->${secondPlayer})`, async () => {
      const first = create({player: firstPlayer, color: 0x647466}), second = create({player: secondPlayer, color: 0x918464});
      let sharedEvents, firstEvents, secondEvents;
      try {
        const firstTextures = boneTextures(first), secondTextures = boneTextures(second), {a, b} = independent(first, second, 'two actors');
        assert.ok(a.textures.size > 0 && b.textures.size > 0, 'non-vacuous shared texture check');
        sharedEvents = observe([...a.geometries, ...a.materials, ...a.textures]); firstEvents = observe(firstTextures); secondEvents = observe(secondTextures);
        const untouched = sample(second); settle(first, {speed: 5.5, crouch: true, pitch: .75});
        assert.equal(delta(untouched.local, sample(second).local), 0, 'first mixer cannot animate second');
        const firstState = sample(first); settle(second, {prone: true}); assert.equal(delta(firstState.local, sample(first).local), 0, 'second mixer cannot animate first');
        await assert.rejects(Promise.resolve().then(() => disposeTacticalSoldiers()), 'cache release rejects live actors');
        sharedEvents.check(0, 'failed cache release'); firstEvents.check(0, 'first skin still live'); secondEvents.check(0, 'second skin still live');
        const scene = new THREE.Group(); scene.add(first.root, second.root); release(first); release(first);
        assert.equal(first.root.parent, null); assert.equal(second.root.parent, scene);
        sharedEvents.check(0, 'one actor never frees shared geometry/material/texture'); firstEvents.check(1, 'own bone textures exactly once'); secondEvents.check(0, 'survivor texture not released');
        for (const s of a.skeletons) assert.equal(s.boneTexture, null);
        await assert.rejects(Promise.resolve().then(() => disposeTacticalSoldiers()), 'survivor blocks cache release');
        for (const weapon of [...WEAPONS, null]) { settle(second, {speed: 3, weapon}, 12); sample(second); guns(second.root, weapon); unchanged(second.root, b, 'survivor'); }
        release(second); release(second); secondEvents.check(1, 'survivor own textures once'); sharedEvents.check(0, 'last actor retains reset cache');
      } finally { release(first); release(second); sharedEvents?.remove(); firstEvents?.remove(); secondEvents?.remove(); }
    });
  }
  await test('three resets: 48/dispose/48, factory+mixer+update allocate no geometry/material', () => {
    const guard = sentinels(); let reference;
    try {
      for (let reset = 0; reset < 3; reset++) {
        const pool = [];
        try {
          for (let i = 0; i < 48; i++) {
            const actor = create({player: i === 0, color: i % 2 ? 0x647466 : 0x918464}); pool.push(actor);
            const owned = resources(actor.root); if (!reference) reference = owned; else shared(reference, owned, 'reset ' + reset);
            if (i) independent(pool[0], actor, '48 pool');
          }
          const allBones = new Set(), allSkins = new Set(), allSkeletons = new Set();
          for (const [i, actor] of pool.entries()) {
            const owned = resources(actor.root);
            for (const [key, seen] of [['bones', allBones], ['skins', allSkins], ['skeletons', allSkeletons]]) for (const v of owned[key]) { assert.ok(!seen.has(v), '48 independent ' + key); seen.add(v); }
            actor.update({dt: .016, speed: i % 7, pitch: Math.sin(i) * .75, weapon: WEAPONS[i % 4]}); matrices(actor, 'reset actor ' + i);
          }
          assert.equal(allBones.size, 48 * 65); assert.equal(allSkins.size, 48 * 3); sample(pool[0]); sample(pool[47]);
        } finally { for (const actor of pool) release(actor); }
      }
      guard.check('prepared factory/mixer/reset update');
    } finally { guard.dispose(); }
  });
  await test('zero-live explicit cache release frees shared assets/texture once; offline re-prepare works', async () => {
    const actor = create(), owned = resources(actor.root); assert.ok(owned.textures.has(fixture));
    const events = observe([...owned.geometries, ...owned.materials, ...owned.textures]);
    try {
      release(actor); events.check(0, 'last actor retains shared cache'); assert.equal(live.size, 0);
      await disposeTacticalSoldiers(); events.check(1, 'cache releases every shared geometry/material/texture once');
      await disposeTacticalSoldiers(); events.check(1, 'cache release idempotent'); await prepareTacticalSoldiers(payload);
      const nextActor = create({player: true});
      try {
        const next = resources(nextActor.root);
        for (const g of next.geometries) assert.ok(!owned.geometries.has(g), 'not previously disposed geometry');
        for (const m of next.materials) assert.ok(!owned.materials.has(m), 'not previously disposed material'); settle(nextActor); sample(nextActor);
      } finally { release(nextActor); }
    } finally { release(actor); events.remove(); }
  });
}
try { await main(); }
catch (error) { failed++; console.error('FAIL unexpected harness error: ' + error.stack); }
finally {
  for (const actor of [...live]) release(actor);
  try { await disposeTacticalSoldiers(); } catch (error) { failed++; console.error('FAIL final cleanup: ' + error.stack); }
}
console.log(`${count - failed}/${count} tactical soldier tests passed`); process.exitCode = failed ? 1 : 0;
