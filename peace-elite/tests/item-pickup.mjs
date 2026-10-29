import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {Game} from '../src/game.js';
import {HUD} from '../src/hud.js';
import {createInventory} from '../src/rules.js';
let total=0,failed=0;
function test(name,run){total++;try{run();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+': '+error.stack);}}
function fixture(){
  const g=Object.create(Game.prototype),notices=[];
  const player={x:0,y:0,z:0,phase:'ground',alive:true,isPlayer:true,inventory:createInventory(),velX:0,velZ:0};
  Object.assign(g,{player,screen:'playing',loot:[],vehicles:[],input:{locked:false,move:{x:0,y:0},unlockSprint(){this.locked=false;this.move={x:0,y:0};}},
    audio:{pickup(){}},hud:{toast:m=>notices.push(m)},viewmodel:{setWeapon(){}},updateHud(){this.hudUpdates=(this.hudUpdates||0)+1;},notices,
    dynamic:new THREE.Group(),world:{heightAt:()=>0},rng:()=>.5});
  return g;
}
function add(g,id,item={kind:'ammo',id:'556',amount:30},x=1,y=.16){const loot={id,item,x,y,z:0,active:true,mesh:{visible:true}};g.loot.push(loot);return loot;}
test('clicking one item never picks its neighbour',()=>{
  const g=fixture(),a=add(g,1),b=add(g,2,{kind:'ammo',id:'762',amount:30});
  assert.equal(g.pickupLoot(2),true);assert.equal(g.player.inventory.ammo['762'],30);assert.equal(g.player.inventory.ammo['556'],0);
  assert.equal(a.active,true);assert.equal(b.active,false);assert.equal(g.notices.length,0);
});
test('double click and already-taken items cannot duplicate loot',()=>{
  const g=fixture();add(g,1);g.pickupLoot(1);assert.equal(g.pickupLoot(1),false);assert.equal(g.player.inventory.ammo['556'],30);
  const stolen=add(g,2);stolen.active=false;assert.equal(g.pickupLoot(2),false);
});
test('click revalidates range and floor height',()=>{
  for(const [x,y] of [[3.1,.16],[8,.16],[1,2.5],[1,4]]){
    const g=fixture();add(g,1,undefined,x,y);assert.equal(g.pickupLoot(1),false);assert.equal(g.player.inventory.ammo['556'],0);
  }
});
test('stale item id cannot pick a different item after list reorder',()=>{
  const g=fixture(),old=add(g,1),remaining=add(g,2,{kind:'ammo',id:'762',amount:30});old.active=false;g.loot.reverse();
  assert.equal(g.pickupLoot(1),false);assert.equal(remaining.active,true);assert.equal(g.player.inventory.ammo['762'],0);
});
test('pause, menus, editing, air and vehicle block card actions',()=>{
  for(const state of [{screen:'paused'},{screen:'editing'},{screen:'result'},{mapOpen:true},{inventoryOpen:true},{helpOpen:true},{vehicle:{}},{touchLayout:{editing:true}}]){
    const g=fixture();add(g,1);Object.assign(g,state);assert.equal(g.pickupLoot(1),false);assert.equal(g.loot[0].active,true);
  }
  for(const phase of ['plane','parachute']){const g=fixture();add(g,1);g.player.phase=phase;assert.equal(g.pickupLoot(1),false);}
});
test('full capacity keeps item and puts the reason on its card',()=>{
  const g=fixture(),item=add(g,1);g.player.inventory.ammo['556']=500;
  assert.equal(g.pickupLoot(1),false);assert.equal(item.active,true);assert.equal(g.lootFeedback.id,1);assert.match(g.lootFeedback.message,/已满/);assert.equal(g.notices.length,0);
});
test('partial stack stays under the same id with the correct remainder',()=>{
  const g=fixture(),item=add(g,1,{kind:'ammo',id:'556',amount:50});g.player.inventory.ammo['556']=490;
  assert.equal(g.pickupLoot(1),true);assert.equal(g.player.inventory.ammo['556'],500);assert.equal(item.active,true);assert.equal(item.item.amount,40);assert.equal(item.id,1);
});
test('card pickup cancels auto sprint and drift',()=>{
  const g=fixture();add(g,1);g.input.locked=true;g.player.velX=6;g.player.velZ=1;
  g.pickupLoot(1);assert.equal(g.input.locked,false);assert.equal(g.player.velX,0);assert.equal(g.player.velZ,0);
});
test('unknown and malformed ids are ignored',()=>{
  for(const id of [0,-1,NaN,Infinity,{},'1',999]){const g=fixture();add(g,1);assert.equal(g.pickupLoot(id),false);assert.equal(g.loot[0].active,true);}
});
test('vehicle action does not pick nearby loot and can exit',()=>{
  const g=fixture(),item=add(g,1),car={x:2,z:0};g.vehicles=[car];
  globalThis.document={body:{classList:{add(){},remove(){}}}};
  assert.equal(g.interactVehicle(),true);assert.equal(g.vehicle,car);assert.equal(item.active,true);
  let exited=false;g.exitVehicle=()=>{exited=true;g.vehicle=null;};g.interactVehicle();assert.equal(exited,true);
});
test('real loot creation keeps monotonically increasing ids across match resets',()=>{
  const g=fixture(),a=g.addLootObject({kind:'ammo',id:'556',amount:30},0,0),b=g.addLootObject({kind:'medkit',amount:1},1,0);
  g.loot=[];const c=g.addLootObject({kind:'ammo',id:'762',amount:30},2,0);
  assert.ok(Number.isSafeInteger(a.id)&&a.id>0);assert.ok(b.id>a.id&&c.id>b.id);
});
test('non-loot notifications route only to the side event feed',()=>{
  let args;HUD.prototype.toast.call({feedTimers:new Map(),_notice(...value){args=value;}},'测试反馈');assert.equal(args[0],'kill-feed');assert.equal(args[1],'feed-entry');
});
test('template has item cards and no central text or generic interaction nodes',()=>{
  const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
  for(const id of ['interaction-prompt','prompt-text','air-status','air-note','toast-stack','touch-interact'])assert.ok(!html.includes(`id="${id}"`),id);
  assert.ok(!html.includes('data-touch="interact"'));assert.ok(html.includes('id="nearby-loot-list"'));assert.ok(html.includes('id="touch-vehicle"'));
  assert.ok(html.includes('id="action-progress"'));assert.ok(html.includes('id="touch-airdrop"'));
});
test('pointer click must match the item pressed before DOM changes',()=>{
  const hud=Object.create(HUD.prototype);hud.lootGestures=new Map([[7,{pointerId:7,id:'100'}]]);
  assert.equal(hud._acceptLootClick({detail:1,pointerId:7},'101'),false);
  assert.equal(hud.lootGestures.size,0);
  hud.lootGestures.set(8,{pointerId:8,id:'102'});assert.equal(hud._acceptLootClick({detail:1,pointerId:8},'102'),true);
  assert.equal(hud._acceptLootClick({detail:1,pointerId:9},'102'),false);
});
test('legacy pointer events require a single matching gesture; keyboard remains usable',()=>{
  const hud=Object.create(HUD.prototype);hud.lootGestures=new Map([[1,{pointerId:1,id:'10'}]]);
  assert.equal(hud._acceptLootClick({detail:1},'11'),false);
  hud.lootGestures.set(2,{pointerId:2,id:'12'});assert.equal(hud._acceptLootClick({detail:1},'12'),true);
  assert.equal(hud._acceptLootClick({detail:0},'12'),true);
});
function nearbyHud(){
  const hud=Object.create(HUD.prototype),hidden={};
  globalThis.document={body:{classList:{contains:()=>false,toggle(){}}}};
  Object.assign(hud,{screen:'playing',data:{phase:'ground',nearbyLoot:[{id:1}],vehicleLabel:''},lootGestures:new Map([[1,{id:'1'}]]),_hidden(id,value){hidden[id]=value;}});
  return {hud,hidden};
}
test('nearby list closes without picking and can reopen',()=>{
  const {hud,hidden}=nearbyHud();hud._syncNearbyControls();assert.equal(hidden['nearby-loot'],false);
  hud.setLootCollapsed(true);assert.equal(hidden['nearby-loot'],true);assert.equal(hidden['loot-reopen'],false);assert.equal(hud.lootGestures.size,0);
  hud._syncNearbyControls();assert.equal(hidden['nearby-loot'],true);
  hud.setLootCollapsed(false);assert.equal(hidden['nearby-loot'],false);assert.equal(hidden['loot-reopen'],true);
});
test('leaving loot range resets collapse and shows nothing until new items appear',()=>{
  const {hud,hidden}=nearbyHud();hud.setLootCollapsed(true);hud.data.nearbyLoot=[];hud._syncNearbyControls();
  assert.equal(hidden['nearby-loot'],true);assert.equal(hidden['loot-reopen'],true);assert.equal(hud.lootCollapsed,false);
  hud.data.nearbyLoot=[{id:2}];hud._syncNearbyControls();assert.equal(hidden['nearby-loot'],false);
});
test('pause and overlays hide both nearby panel and reopen button',()=>{
  const {hud,hidden}=nearbyHud();hud.setLootCollapsed(true);hud.screen='paused';hud._syncNearbyControls();assert.equal(hidden['loot-reopen'],true);
  hud.screen='playing';hud.mapOpen=true;hud._syncNearbyControls();assert.equal(hidden['loot-reopen'],true);assert.equal(hidden['nearby-loot'],true);
});
console.log(`${total-failed}/${total} item pickup tests passed`);process.exitCode=failed?1:0;
