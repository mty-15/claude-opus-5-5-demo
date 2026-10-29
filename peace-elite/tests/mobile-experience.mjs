import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Input } from '../src/input.js';
import { Game } from '../src/game.js';
import { HUD } from '../src/hud.js';
import { CollisionWorld, raySphereDistance } from '../src/physics.js';
import { createInventory, WEAPONS } from '../src/rules.js';
import { touchEnabled, normalizeTouchSettings, loadTouchSettings, saveTouchSettings, touchLookRadians } from '../src/touch-settings.js';

let total=0,failures=0;
function test(name,fn){total++;try{fn();console.log(`PASS ${name}`);}catch(error){failures++;console.error(`FAIL ${name}: ${error.stack}`);}}
function classes(){const values=new Set();return {add:v=>values.add(v),remove:v=>values.delete(v),contains:v=>values.has(v),toggle:(v,on)=>on?values.add(v):values.delete(v)};}
class Target extends EventTarget {
  constructor(action){super();this.dataset={touch:action};this.classList=classes();this.style={};this.tagName='BUTTON';}
  setPointerCapture(){} releasePointerCapture(){}
  getBoundingClientRect(){return {left:0,top:0,width:112,height:112};}
  querySelector(){return {style:{}};}
}
function setupInput(){
  const canvas=new Target(),stick=new Target('move'),fire=new Target('fire'),secondFire=new Target('fire'),aim=new Target('aim');
  const doc=new Target();doc.body={classList:classes()};doc.querySelector=()=>stick;
  doc.querySelectorAll=()=>[fire,secondFire,aim];
  globalThis.document=doc;globalThis.window=new Target();globalThis.innerWidth=844;
  globalThis.matchMedia=()=>({matches:true});globalThis.location={search:''};
  const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const input=new Input(canvas,{onPause(){},onError(){}});input.setActive(true);
  return {input,canvas,stick,fire,secondFire,aim};
}
function pointer(target,type,id,x=56,y=56){const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:id,clientX:x,clientY:y,pointerType:'touch'});target.dispatchEvent(event);}
function gameFixture(){
  const g=Object.create(Game.prototype),inventory=createInventory();inventory.slots[0]={id:'m416',rounds:30};
  const player={x:0,y:0,z:0,yaw:0,pitch:0,vy:0,speed:0,isPlayer:true,alive:true,phase:'ground',inventory,model:{root:{visible:true}}};
  globalThis.document={body:{classList:classes()}};
  Object.assign(g,{player,actors:[player],time:0,aim:false,thirdPerson:true,recoil:0,world:{heightAt:()=>0},collision:new CollisionWorld([],()=>0),camera:new THREE.PerspectiveCamera(72,844/390,.07,2600)});
  g.updateCamera(1);return g;
}

test('fire button drag accumulates aim while keeping fire held',()=>{
  const {input,fire}=setupInput();pointer(fire,'pointerdown',1,300,180);pointer(fire,'pointermove',1,240,180);
  const controls=input.sample();assert.ok(controls.held.has('fire'));assert.ok(controls.touchDx<0);assert.equal(controls.touchDy,0);
  pointer(fire,'pointerup',1,240,180);assert.ok(!input.sample().held.has('fire'));assert.equal(input.lookPointer,undefined);
  input.dispose();
});
test('left joystick and right fire-drag operate simultaneously',()=>{
  const {input,stick,fire}=setupInput();pointer(stick,'pointerdown',1,56,30);pointer(fire,'pointerdown',2,300,180);
  pointer(fire,'pointermove',2,260,160);const state=input.sample();
  assert.ok(state.move.y>0);assert.ok(state.held.has('fire'));assert.ok(state.touchDx<0&&state.touchDy<0);
  pointer(fire,'pointerup',2);assert.ok(input.move.y>0);pointer(stick,'pointerup',1);assert.equal(input.move.y,0);input.dispose();
});
test('second fire pointer survives release of the first',()=>{
  const {input,fire,secondFire}=setupInput();pointer(fire,'pointerdown',1);pointer(secondFire,'pointerdown',2);
  pointer(fire,'pointerup',1);assert.ok(input.sample().held.has('fire'));pointer(secondFire,'pointercancel',2);
  assert.ok(!input.sample().held.has('fire'));input.dispose();
});
test('look ownership transfers from canvas to held fire without a jump',()=>{
  const {input,canvas,fire}=setupInput();pointer(canvas,'pointerdown',1,100,100);pointer(fire,'pointerdown',2,300,200);
  pointer(fire,'pointermove',2,320,200);assert.equal(input.sample().touchDx,0);
  pointer(canvas,'pointerup',1);assert.equal(input.lookPointer,2);assert.equal(input.sample().touchDx,0);
  pointer(fire,'pointermove',2,330,200);assert.ok(Math.abs(input.sample().touchDx-touchLookRadians(10,844,100))<1e-12);
  assert.ok(input.sample().held.has('fire'));input.dispose();
});
test('look ownership transfers back to a waiting canvas finger',()=>{
  const {input,canvas,fire}=setupInput();pointer(fire,'pointerdown',1,300,200);pointer(canvas,'pointerdown',2,100,100);
  pointer(canvas,'pointermove',2,120,100);pointer(fire,'pointerup',1);assert.equal(input.lookPointer,2);
  pointer(canvas,'pointermove',2,130,100);assert.ok(Math.abs(input.sample().touchDx-touchLookRadians(10,844,100))<1e-12);input.dispose();
});
test('pause reset clears fire, look deltas and visual pressed state',()=>{
  const {input,fire}=setupInput();pointer(fire,'pointerdown',1);pointer(fire,'pointermove',1,76,60);
  input.setActive(false);const state=input.sample();assert.equal(state.touchDx,0);assert.equal(state.held.size,0);
  assert.equal(fire.classList.contains('pressed'),false);input.dispose();
});
test('pointer cancellation cancels a locked joystick instead of autorunning',()=>{
  const {input,stick}=setupInput();pointer(stick,'pointerdown',1,56,-20);input.tick(.7);assert.equal(input.locked,true);
  pointer(stick,'pointercancel',1);assert.equal(input.locked,false);assert.deepEqual(input.move,{x:0,y:0});input.dispose();
});
test('lost capture releases view input and permits the next swipe',()=>{
  const {input,canvas}=setupInput();pointer(canvas,'pointerdown',1);pointer(canvas,'lostpointercapture',1);
  pointer(canvas,'pointerdown',2);pointer(canvas,'pointermove',2,86,56);assert.ok(input.sample().touchDx>0);input.dispose();
});
test('touch deltas are consumed once and do not depend on event frequency',()=>{
  const a=setupInput();pointer(a.canvas,'pointerdown',1,100,100);pointer(a.canvas,'pointermove',1,200,100);
  const one=a.input.sample().touchDx;assert.equal(a.input.sample().touchDx,0);a.input.dispose();
  const b=setupInput();pointer(b.canvas,'pointerdown',1,100,100);
  for(let x=110;x<=200;x+=10)pointer(b.canvas,'pointermove',1,x,100);
  assert.ok(Math.abs(one-b.input.sample().touchDx)<1e-12);b.input.dispose();
});
test('same viewport fraction turns equally on different screen widths',()=>{
  assert.equal(touchLookRadians(400,800,100),touchLookRadians(500,1000,100));
  assert.ok(touchLookRadians(100,844,60)<touchLookRadians(100,844,100));
});
test('ADS uses saved independent sensitivity; scope halves it again',()=>{
  const {input,canvas,aim}=setupInput();input.touchSettings={look:100,ads:40};
  pointer(aim,'pointerdown',5);pointer(aim,'pointerup',5);input.scopeScale=.5;
  pointer(canvas,'pointerdown',1,100,100);pointer(canvas,'pointermove',1,200,100);
  assert.ok(Math.abs(input.sample().touchDx-touchLookRadians(100,844,40,.5))<1e-12);input.dispose();
});
test('touch detection includes explicit touch preview and desktop stays desktop',()=>{
  assert.equal(touchEnabled({location:{search:'?touch'},navigator:{maxTouchPoints:0},matchMedia:()=>({matches:false})}),true);
  assert.equal(touchEnabled({navigator:{maxTouchPoints:0},matchMedia:()=>({matches:false})}),false);
});
test('settings persist and corrupted values safely use defaults',()=>{
  setupInput();saveTouchSettings({look:135,ads:45});assert.deepEqual(loadTouchSettings(),{look:135,ads:45});
  globalThis.localStorage.getItem=()=>'{bad';assert.deepEqual(loadTouchSettings(),{look:100,ads:60});
  assert.deepEqual(normalizeTouchSettings({look:999,ads:-1}),{look:180,ads:20});
  assert.deepEqual(normalizeTouchSettings({look:'90',ads:NaN}),{look:100,ads:60});
});
test('third-person camera really sits on the right shoulder',()=>{
  const g=gameFixture();assert.ok(g.camera.position.x>g.player.x);assert.ok(g.camera.position.z>g.player.z);
});
test('near and far targets under the reticle are on the shot ray',()=>{
  for(const distance of [6,20,80]){
    const g=gameFixture(),view=g.camera.getWorldDirection(new THREE.Vector3());
    const head=g.camera.position.clone().addScaledVector(view,distance);
    const enemy={x:head.x,y:head.y-1.57,z:head.z,alive:true,phase:'ground',release:0};g.actors.push(enemy);
    const direction=g.aimDirection(260),muzzle={x:0,y:1.63,z:0};
    assert.notEqual(raySphereDistance(muzzle,direction,head,.22,260),null,`missed at ${distance}m`);
  }
});
test('camera shoulder offset participates in obstruction query',()=>{
  const g=gameFixture();let ray;
  g.collision.ray=(origin,direction)=>{ray=direction.clone();return .8;};g.updateCamera(.016);
  assert.ok(ray.x>0);const focus=new THREE.Vector3(0,1.63-.42,0);
  assert.ok(g.camera.position.distanceTo(focus)<=.66);
});
test('crouch and prone keep a horizontal look direction on flat ground',()=>{
  for(const posture of ['crouch','prone']) {
    const g=gameFixture();g.player[posture]=true;g.updateCamera(1);
    const view=g.camera.getWorldDirection(new THREE.Vector3());
    assert.ok(Math.abs(view.y)<1e-9,`${posture}: camera forced toward the ground`);
    assert.ok(g.camera.position.y>=.4);
  }
});
test('sniper ADS switches to first-person scope and removes head bob',()=>{
  const g=gameFixture();g.player.inventory.slots[0]={id:'kar98',rounds:5};g.aim=true;g.player.speed=4;g.time=10;
  g.updateCamera(1);assert.ok(Math.abs(g.camera.position.y-1.63)<1e-12);assert.equal(g.camera.position.x,0);
  assert.ok(g.camera.fov<26);assert.equal(document.body.classList.contains('scoped'),true);
  g.aim=false;g.updateCamera(1);assert.equal(document.body.classList.contains('scoped'),false);assert.ok(g.camera.position.x>0);
});
test('actual firePlayer path hits the close target beneath the reticle',()=>{
  const g=gameFixture(),view=g.camera.getWorldDirection(new THREE.Vector3());
  const head=g.camera.position.clone().addScaledVector(view,8);
  const enemy={x:head.x,y:head.y-1.57,z:head.z,alive:true,phase:'ground',release:0};g.actors.push(enemy);
  let hits=0;g.hurt=actor=>{assert.equal(actor,enemy);hits++;};g.tracer=()=>{};g.burst=()=>{};
  g.audio={shot(){},hit(){}};g.hud={hit(){}};g.rng=()=>.5;g.shotCooldown=0;
  g.firePlayer();assert.equal(hits,1);assert.equal(g.player.inventory.slots[0].rounds,29);
});
test('cover between muzzle and target still blocks a reticle-aligned shot',()=>{
  const g=gameFixture();g.collision=new CollisionWorld([{minX:-3,maxX:3,minY:0,maxY:3,minZ:-4,maxZ:-3}],()=>0);
  const enemy={x:0,y:0,z:-10,alive:true,phase:'ground',release:0};g.actors.push(enemy);
  let damage=0;g.hurt=()=>damage++;g.tracer=()=>{};g.burst=()=>{};g.audio={hit(){}};g.hud={hit(){}};
  g.shoot(g.player,{x:0,y:1.63,z:0},new THREE.Vector3(0,0,-1),WEAPONS.m416);assert.equal(damage,0);
});
test('HUD reset preserves device mode on first menu and return to menu',()=>{
  globalThis.matchMedia=()=>({matches:true});
  for(const [data,expected] of [[{},true],[{touch:true,phase:'ground'},true],[{touch:false,phase:'ground'},false]]) {
    const hud=Object.create(HUD.prototype);let observed;
    Object.assign(hud,{data,feedTimers:new Map(),toastTimers:new Map(),_class(){},update(){observed=this.data.touch;}});
    hud._resetMatch();assert.equal(observed,expected);assert.deepEqual(hud.data,{touch:expected});
  }
});
console.log(`${total-failures}/${total} mobile experience tests passed`);process.exitCode=failures?1:0;
