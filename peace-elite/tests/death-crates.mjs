import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Game} from '../src/game.js';
import {CollisionWorld} from '../src/physics.js';
import {createInventory} from '../src/rules.js';
import {inventoryToLoot} from '../src/loot-boxes.js';
let count=0,failed=0;
function test(name,run){count++;try{run();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+': '+error.stack);}}
const noop=()=>{};
function fixture(){
 const g=Object.create(Game.prototype);
 const input={active:true,cursorMode:false,keys:new Map(),move:{x:0,y:0},reset(){this.keys.clear();this.move={x:0,y:0};},setCursor(value){this.cursorMode=value;this.reset();},setActive(value){this.active=value;if(!value){this.cursorMode=false;this.reset();}},unlockSprint(){this.locked=false;},lock:noop};
 const player={id:0,x:0,y:0,z:0,yaw:0,pitch:0,phase:'ground',isPlayer:true,alive:true,health:100,inventory:createInventory(),model:{dispose:noop,update:noop,root:{visible:true}}};
 Object.assign(g,{player,actors:[player],loot:[],lootCrates:[],vehicles:[],grenades:[],particles:[],tracers:[],screen:'playing',time:10,elapsed:0,kills:0,boost:0,fps:60,touchMode:true,input,
  collision:new CollisionWorld([],()=>0),world:{heightAt:()=>0,locations:[]},dynamic:new THREE.Group(),audio:new Proxy({},{get:()=>noop}),viewmodel:{setWeapon:noop,root:{visible:false}},zoneWall:{visible:false},nextCircle:{visible:false},rng:()=>.5});
 g.hud={toast:noop,feed:noop,setMap:noop,setInventory:noop,setHelp:noop,setScreen:noop,update:data=>{g.hudState=data;}};
 globalThis.document={body:{classList:{add:noop,remove:noop,toggle:noop}}};
 return g;
}
function enemy(g,inventory=createInventory(),position={x:1,y:0,z:0}){
 const actor={...position,id:g.actors.length,name:'测试敌人',yaw:.3,phase:'ground',isPlayer:false,alive:true,health:100,inventory,model:{update:noop,dispose:noop}};g.actors.push(actor);return actor;
}
function equipped(){const i=createInventory();i.slots=[{id:'m416',rounds:7},{id:'akm',rounds:0}];i.ammo['556']=120;i.ammo['762']=65;i.medkits=2;i.boosts=3;i.grenades=1;i.armor=2;i.helmet=3;return i;}
function killWith(g,inv){const actor=enemy(g,inv);g.kill(actor,g.player);return {actor,crate:g.lootCrates[0]};}
function entry(crate,kind,id){return crate.items.find(e=>e.active&&e.item.kind===kind&&(id===undefined||e.item.id===id));}

test('inventory snapshot preserves all actual contents and zero-round weapons',()=>{
 const inv=equipped(),copy=structuredClone(inv),items=inventoryToLoot(inv);assert.deepEqual(inv,copy);assert.equal(items.length,9);
 assert.deepEqual(items.find(x=>x.id==='akm'),{kind:'weapon',id:'akm',rounds:0});assert.equal(items.find(x=>x.kind==='boost').amount,3);
 inv.slots[0].rounds=30;inv.ammo['556']=0;assert.equal(items.find(x=>x.id==='m416').rounds,7);assert.equal(items.find(x=>x.kind==='ammo'&&x.id==='556').amount,120);
});
test('enemy death creates one box rather than scattered loot and transfers inventory',()=>{
 const g=fixture(),inv=equipped(),expected=inventoryToLoot(inv),{actor,crate}=killWith(g,inv);
 assert.equal(g.loot.length,0);assert.equal(g.lootCrates.length,1);assert.deepEqual(crate.items.map(x=>x.item),expected);assert.deepEqual(actor.inventory,createInventory());
 assert.equal(crate.mesh.parent,g.dynamic);assert.equal(crate.mesh.userData.marker.visible,true);assert.equal(g.kills,1);
 g.kill(actor,g.player);assert.equal(g.lootCrates.length,1);assert.equal(g.kills,1);assert.equal(g.addDeathCrate(actor),crate);
});
test('empty enemy leaves an inspectable empty box, without invented equipment',()=>{
 const g=fixture(),{crate}=killWith(g,createInventory());assert.equal(crate.items.length,0);assert.equal(crate.mesh.userData.marker.visible,false);
 assert.equal(g.openLootCrate(crate.id),true);assert.deepEqual(g.hudState.lootCrate.items,[]);
});
test('box rests on the actual floor under the death, not under the building',()=>{
 const g=fixture();g.collision.floorAt=()=>12;const actor=enemy(g,equipped(),{x:1,y:12,z:0});g.kill(actor,g.player);
 const crate=g.lootCrates[0];assert.equal(crate.y,12);assert.equal(crate.mesh.position.y,12);assert.ok(new THREE.Box3().setFromObject(crate.mesh).min.y>=12);
 assert.equal(g.openLootCrate(crate.id),false);g.player.y=12;assert.equal(g.openLootCrate(crate.id),true);
});
test('box contents do not appear as ground loot and cannot be picked through ground API',()=>{
 const g=fixture(),{crate}=killWith(g,equipped());assert.deepEqual(g.nearbyLoot(g.player),[]);
 assert.equal(g.pickupLoot(crate.items[0].id),false);g.updateHud();assert.equal(g.hudState.nearbyLoot.length,0);assert.equal(g.hudState.nearbyCrates[0].id,crate.id);
});
test('opening never auto-picks; clicking one boxed weapon preserves its magazine',()=>{
 const g=fixture(),{crate}=killWith(g,equipped()),gun=entry(crate,'weapon','m416');g.openLootCrate(crate.id);
 assert.deepEqual(g.player.inventory,createInventory());assert.equal(g.pickupCrateLoot(crate.id,gun.id),true);
 assert.deepEqual(g.player.inventory.slots[0],{id:'m416',rounds:7});assert.equal(gun.active,false);assert.equal(g.player.inventory.ammo['556'],0);
 assert.equal(crate.items.filter(x=>x.active).length,8);assert.equal(g.pickupCrateLoot(crate.id,gun.id),false);
});
test('full capacity keeps boxed stack and returns a reason',()=>{
 const g=fixture(),{crate}=killWith(g,equipped()),ammo=entry(crate,'ammo','556');g.player.inventory.ammo['556']=500;g.openLootCrate(crate.id);
 assert.equal(g.pickupCrateLoot(crate.id,ammo.id),false);assert.equal(ammo.item.amount,120);assert.equal(ammo.active,true);assert.match(g.crateFeedback.message,/已满/);
});
test('partial ammo pickup leaves the correct quantity and identity in the box',()=>{
 const g=fixture(),{crate}=killWith(g,equipped()),ammo=entry(crate,'ammo','556'),id=ammo.id;g.player.inventory.ammo['556']=490;g.openLootCrate(crate.id);
 assert.equal(g.pickupCrateLoot(crate.id,id),true);assert.equal(g.player.inventory.ammo['556'],500);assert.equal(ammo.item.amount,110);assert.equal(ammo.id,id);assert.equal(ammo.active,true);
});
test('replaced weapon goes back into the same box with its original magazine',()=>{
 const g=fixture(),inv=createInventory();inv.slots[0]={id:'akm',rounds:17};const {crate}=killWith(g,inv),gun=entry(crate,'weapon','akm');
 g.player.inventory.slots=[{id:'m416',rounds:5},{id:'ump45',rounds:9}];g.openLootCrate(crate.id);g.pickupCrateLoot(crate.id,gun.id);
 assert.deepEqual(g.player.inventory.slots[0],{id:'akm',rounds:17});assert.equal(g.loot.length,0);
 assert.deepEqual(entry(crate,'weapon','m416').item,{kind:'weapon',id:'m416',rounds:5});assert.ok(entry(crate,'weapon','m416').id>gun.id);
});
test('emptying the box keeps its model but removes its contents marker',()=>{
 const g=fixture(),inv=createInventory();inv.medkits=1;const {crate}=killWith(g,inv);g.openLootCrate(crate.id);g.pickupCrateLoot(crate.id,crate.items[0].id);
 assert.equal(g.player.inventory.medkits,1);assert.equal(crate.mesh.parent,g.dynamic);assert.equal(crate.mesh.userData.marker.visible,false);
 assert.equal(g.openCrateId,crate.id);assert.equal(g.hudState.lootCrate.items.length,0);
});
test('closed, wrong-box, stale and malformed entry clicks never collect',()=>{
 const g=fixture(),{crate}=killWith(g,equipped()),item=crate.items[0];assert.equal(g.pickupCrateLoot(crate.id,item.id),false);
 g.openLootCrate(crate.id);assert.equal(g.pickupCrateLoot(crate.id+100,item.id),false);
 for(const id of [0,-1,NaN,'1',99999])assert.equal(g.pickupCrateLoot(crate.id,id),false);
 g.closeLootCrate();assert.equal(g.pickupCrateLoot(crate.id,item.id),false);assert.equal(item.active,true);
});
test('moving out of range auto-closes the box without clearing held movement',()=>{
 const g=fixture(),{crate}=killWith(g,equipped());g.openLootCrate(crate.id);g.input.keys.set('KeyW','forward');g.player.x=20;g.updateHud();
 assert.equal(g.openCrateId,null);assert.equal(g.hudState.lootCrate,null);assert.equal(g.input.cursorMode,false);assert.equal(g.input.keys.get('KeyW'),'forward');
 assert.equal(g.pickupCrateLoot(crate.id,crate.items[0].id),false);
});
test('pause, overlays, vehicles, air and dead player reject crate access',()=>{
 for(const blocked of [{screen:'paused'},{mapOpen:true},{inventoryOpen:true},{helpOpen:true},{vehicle:{}},{touchLayout:{editing:true}}]){
  const g=fixture(),{crate}=killWith(g,equipped());Object.assign(g,blocked);assert.equal(g.openLootCrate(crate.id),false);
 }
 const g=fixture(),{crate}=killWith(g,equipped());g.player.phase='parachute';assert.equal(g.openLootCrate(crate.id),false);g.player.phase='ground';g.player.alive=false;assert.equal(g.openLootCrate(crate.id),false);
});
test('pause closes the box and Esc closes it before pausing the match',()=>{
 const g=fixture(),{crate}=killWith(g,equipped());g.openLootCrate(crate.id);g.commands({pressed:new Set(['pause'])});assert.equal(g.openCrateId,null);assert.equal(g.screen,'playing');
 g.openLootCrate(crate.id);g.pause();assert.equal(g.openCrateId,null);assert.equal(g.screen,'paused');
});
test('match reset disposes box geometry and clears box state without reusing ids',()=>{
 const g=fixture(),{crate}=killWith(g,equipped());g.openLootCrate(crate.id);let disposed=0;
 const geometries=new Set();crate.mesh.traverse(o=>{if(o.geometry)geometries.add(o.geometry)});for(const geometry of geometries)geometry.addEventListener('dispose',()=>disposed++);
 const lastId=Math.max(crate.id,...crate.items.map(x=>x.id));g.resetMatch();assert.deepEqual(g.lootCrates,[]);assert.equal(g.openCrateId,null);assert.equal(crate.mesh.parent,null);assert.equal(disposed,geometries.size);
 const next=g.addDeathCrate(enemy(g,createInventory()));assert.ok(next.id>lastId);
});
console.log(`${count-failed}/${count} death crate tests passed`);process.exitCode=failed?1:0;
