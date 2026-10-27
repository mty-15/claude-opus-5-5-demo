import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { Input } from '../src/input.js';
import { CollisionWorld } from '../src/physics.js';
import { createInventory } from '../src/rules.js';

// Direct execution avoids spawning a test worker; fixtures use the real game methods.
let failures = 0, total = 0;
function test(name, run) {
  total++;
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
function inputFixture() {
  const input = Object.create(Input.prototype);
  const classes = new Set();
  input.stickRoot = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 140, height: 140 }),
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
    querySelector: () => ({ style: {} }),
  };
  Object.assign(input, { active: true, keys: new Map(), touchKeys: new Set(), edges: new Set(),
    dx: 0, dy: 0, aim: false, move: {x:0,y:0}, locked: false, lockedMove: {x:0,y:0},
    lockTimer: 0, lockAngle: 0, stickAngle: 0, sprintLockGate: true, stickPointer: undefined });
  return input;
}
function gameFixture(heightAt = () => 0) {
  const game = Object.create(Game.prototype);
  const player = { x:0,y:heightAt(0,0),z:0,yaw:0,pitch:0,vy:0,velX:0,velZ:0,speed:0,
    phase:'ground',alive:true,isPlayer:true,inventory:createInventory(),crouch:false,prone:false };
  const notices = [];
  Object.assign(game, { player, collision:new CollisionWorld([],heightAt), world:{heightAt},
    loot:[], vehicles:[], boost:0, aim:false, input:inputFixture(), action:null,
    hud:{toast:(text)=>notices.push(text)}, audio:{pickup(){},step(){}}, viewmodel:{setWeapon(){}},
    mapOpen:false,inventoryOpen:false,helpOpen:false,notices });
  return game;
}
function loot(game, x, item={kind:'ammo',id:'556',amount:30}, y=.16) {
  const entry={x,y,z:0,item,active:true,mesh:{visible:true}};
  game.loot.push(entry); return entry;
}
function advance(game, move, held=new Set(), frames=120, dt=1/60) {
  for(let i=0;i<frames;i++) game.movePlayer(dt,held,move);
}

test('a displayed pickup at 2.9m is actually collected', () => {
  const g=gameFixture(), item=loot(g,2.9);
  assert.equal(g.nearestLoot(g.player),item);
  g.interact(); assert.equal(g.player.inventory.ammo['556'],30);
  assert.equal(item.active,false);
});
test('prompt and pickup have identical distance and height boundaries', () => {
  for(const x of [0,2.6,2.9,3.09,3.1,3.11,8]) for(const y of [.16,2.49,2.5,2.51]) {
    const g=gameFixture(); loot(g,x,undefined,y);
    assert.equal(!!g.nearestLoot(g.player),g.nearbyLoot(g.player).length>0,`x=${x}, y=${y}`);
  }
});
test('manual interaction collects multiple items, but not distant or other-floor loot', () => {
  const g=gameFixture();
  loot(g,1); loot(g,2,{kind:'weapon',id:'m416'}); loot(g,2.9,{kind:'medkit',amount:1});
  const far=loot(g,8), upstairs=loot(g,1,undefined,4);
  assert.equal(g.player.inventory.ammo['556'],0);
  g.interact(); assert.equal(g.player.inventory.ammo['556'],30);
  assert.equal(g.player.inventory.slots[0].id,'m416'); assert.equal(g.player.inventory.medkits,1);
  assert.equal(far.active,true); assert.equal(upstairs.active,true);
});
test('failed pickup reports capacity instead of silently boarding nearby vehicle', () => {
  const g=gameFixture(); g.player.inventory.ammo['556']=500;
  loot(g,1); g.vehicles=[{x:2,z:0}];
  g.interact(); assert.ok(!g.vehicle); assert.ok(g.notices.some(n=>n.includes('已满')));
});
test('interaction with nothing nearby gives feedback', () => {
  const g=gameFixture(); g.interact(); assert.ok(g.notices.length>0);
});
test('interacting while auto-running cancels run and stops drifting past the loot', () => {
  const g=gameFixture(); loot(g,2.9);
  Object.assign(g.input,{locked:true,lockedMove:{x:0,y:1},move:{x:0,y:1}});
  g.player.velX=6;
  const controls=g.input.sample(); controls.pressed.add('interact'); g.commands(controls);
  assert.equal(g.input.locked,false); assert.deepEqual(controls.move,{x:0,y:0});
  assert.equal(g.player.velX,0); assert.equal(g.player.inventory.ammo['556'],30);
});
test('normal run is 4.4m/s and sprint is 6m/s at 30/60/120 FPS', () => {
  for(const fps of [30,60,120]) for(const [held,expected] of [[new Set(),4.4],[new Set(['sprint']),6]]) {
    const g=gameFixture(); advance(g,{x:0,y:1},held,2*fps,1/fps);
    assert.ok(Math.abs(g.player.speed-expected)<1e-6,`${fps}fps: ${g.player.speed}`);
  }
});
test('full-speed forward can turn right and reverse without releasing controls', () => {
  const g=gameFixture(); advance(g,{x:0,y:1}); const before={x:g.player.x,z:g.player.z};
  advance(g,{x:1,y:0}); assert.ok(g.player.x-before.x>5,'right turn did not take effect');
  assert.ok(Math.abs(g.player.velX)<1e-6);
  advance(g,{x:-1,y:0}); assert.ok(g.player.velZ<0,'reverse did not take effect');
});
test('sprint release stops within 0.3s and under one metre', () => {
  const g=gameFixture(); advance(g,{x:0,y:1},new Set(['sprint'])); const z=g.player.z;
  advance(g,{x:0,y:0},new Set(),18); assert.ok(g.player.speed<1e-6);
  assert.ok(Math.abs(g.player.z-z)<1);
});
test('uphill slows movement but downhill and airborne do not gain speed', () => {
  const g=gameFixture((x,z)=>-z*.3);
  assert.ok(g.slopeFactor(g.player,{x:0,y:1})<1);
  assert.equal(g.slopeFactor(g.player,{x:0,y:-1}),1);
  g.player.y+=5; g.player.vy=3;
  assert.equal(g.slopeFactor(g.player,{x:0,y:1}),1);
});
test('ordinary full joystick deflection does not automatically lock sprint', () => {
  const i=inputFixture(); i.beginStick(1); i.updateStick(70,8.4);
  i.tick(.7); assert.equal(i.locked,false); i.endStick(); assert.deepEqual(i.move,{x:0,y:0});
});
test('over-travel joystick remains full speed rather than becoming slower', () => {
  const i=inputFixture(); i.beginStick(1); i.updateStick(70,-60);
  assert.ok(Math.abs(Math.hypot(i.move.x,i.move.y)-1)<1e-6);
});
test('deliberate upward over-travel locks only after hold; sideways does not', () => {
  const i=inputFixture(); i.beginStick(1); i.updateStick(70,-10);
  i.tick(.25); assert.equal(i.locked,false); i.tick(.4); assert.equal(i.locked,true);
  i.endStick(); assert.equal(i.move.y,1); i.reset(); assert.equal(i.locked,false);
  i.beginStick(2); i.updateStick(150,70); i.tick(1); assert.equal(i.locked,false);
});
test('retracting a locked stick releases sprint and resumes fine positioning', () => {
  const i=inputFixture(); i.beginStick(1); i.updateStick(70,-10); i.tick(1);
  assert.equal(i.locked,true); i.updateStick(70,60); assert.equal(i.locked,false);
  assert.ok(i.move.y>0&&i.move.y<.3); i.endStick(); assert.deepEqual(i.move,{x:0,y:0});
});
test('partial ammo pickup preserves the remainder on the ground', () => {
  const g=gameFixture(); g.player.inventory.ammo['556']=490;
  const item=loot(g,2.9); g.interact();
  assert.equal(g.player.inventory.ammo['556'],500);
  assert.equal(item.active,true); assert.equal(item.item.amount,20);
});
test('interaction cancels pending lock until the next stick gesture', () => {
  const i=inputFixture(); i.beginStick(1); i.updateStick(70,-10); i.tick(.3);
  i.unlockSprint(); i.updateStick(70,-10); i.tick(1); assert.equal(i.locked,false);
  i.endStick(); i.beginStick(2); i.updateStick(70,-10); i.tick(.7); assert.equal(i.locked,true);
});
test('airborne and inactive input cannot lock sprint', () => {
  for(const state of [{sprintLockGate:false},{active:false},{layoutEditing:true}]) {
    const i=inputFixture(); i.beginStick(1); i.updateStick(70,-10); Object.assign(i,state);
    i.tick(1); assert.equal(i.locked,false);
  }
});
test('diagonal speed is normalized and crouch/prone cannot sprint', () => {
  const diagonal=gameFixture(); advance(diagonal,{x:1,y:1});
  assert.ok(Math.abs(diagonal.player.speed-4.4)<1e-6);
  for(const [posture,speed] of [['crouch',2.8],['prone',1.6]]) {
    const g=gameFixture();g.player[posture]=true;advance(g,{x:0,y:1},new Set(['sprint']));
    assert.ok(Math.abs(g.player.speed-speed)<1e-6);
  }
});
console.log(`${total-failures}/${total} passed`);
process.exitCode=failures?1:0;
