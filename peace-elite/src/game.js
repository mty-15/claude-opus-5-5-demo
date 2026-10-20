import * as THREE from 'three';
import { createWorld } from './world.js';
import { createSoldier, createViewmodel, createLootMesh, createVehicle, createPlane } from './models.js';
import { AudioEngine } from './audio.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { TouchLayout } from './touch-layout.js';
import { CollisionWorld, raySphereDistance } from './physics.js';
import { WEAPONS, createInventory, addLoot, reloadWeapon, consumeRound, applyDamage, createZone, advanceZone, zoneSnapshot, isOutsideZone, mulberry32 } from './rules.js';

const PARTICIPANTS = 48;
const EYE_HEIGHT = 1.63;
// 移动手感参数。地面加速 34 m/s² 让步行全速（5.4 m/s）在约 0.16 s 内达到，
// 阻尼 8 m/s² 让松手后约 0.5 s 滑停——既有提速感，又不会松手立刻站住。
const GROUND_ACCEL = 34, GROUND_DAMP = 8, AIR_ACCEL = 6;
const BOT_COMBAT_DISTANCE = 200;
const ACTOR_DRAW_DISTANCE = BOT_COMBAT_DISTANCE + 40;
const BOT_NAMES = ['荒野回声','山海过客','北境来信','伏击手','无声信号','第七小队','落日巡游','一叶知秋','夜航船','逆风行者','海岸守望','山谷猎手','灰狼','追光者','北斗','未眠','寒鸦','归途','轻舟','旧港','鹿鸣','穿林风','南山','逐浪'];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const damp=(a,b,k,dt)=>THREE.MathUtils.lerp(a,b,1-Math.exp(-k*dt));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const eye=a=>({x:a.x,y:a.y+(a.prone?.45:a.crouch?1.05:EYE_HEIGHT),z:a.z});
const dirFor=(yaw,pitch=0)=>new THREE.Vector3(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));
const lootLabel=l=>l.kind==='weapon'?WEAPONS[l.id].name:({ammo:`${l.id==='556'?'5.56':l.id==='762'?'7.62':'9'}毫米弹药 ×${l.amount}`,medkit:'急救包',boost:'能量饮料',armor:`${l.level}级防弹衣`,helmet:`${l.level}级头盔`,grenade:'破片手榴弹'})[l.kind];

export class Game {
  constructor() {
    this.screen='loading';this.elapsed=0;this.menuTime=0;this.time=0;this.matchCount=0;
    this.actors=[];this.loot=[];this.vehicles=[];this.grenades=[];this.particles=[];this.tracers=[];
    this.options={difficulty:'normal',quality:'high',name:'特种兵'};
    this.mapOpen=false;this.inventoryOpen=false;this.helpOpen=false;this.thirdPerson=true;
    this.audio=new AudioEngine();
    this.hud=new HUD({
      start:options=>this.start(options),resume:()=>this.resume(),restart:()=>this.start(this.options),menu:()=>this.menu(),
      setVolume:value=>this.audio.setVolume(value),setQuality:value=>this.setQuality(value),
      setFireMode:auto=>this.setFireMode(auto),
      editTouchLayout:()=>this.editTouchLayout(),
    });
    this.canvas=document.getElementById('game-canvas');
    this.input=new Input(this.canvas,{onPause:()=>this.pause(),onError:message=>this.hud.toast(message,'warning')});
    // 手机端为横屏射击：竖屏时提示旋转并暂停对局，遮罩由 body.portrait 驱动。
    this.touchMode=matchMedia('(pointer: coarse)').matches||new URLSearchParams(location.search).has('touch');
    this.portrait=matchMedia('(orientation: portrait)');
    this.hud.setScreen('loading');
    this.resize=this.resize.bind(this);
    this.frame=this.frame.bind(this);
  }

  async init() {
    this.hud.setLoading(.08,'正在建立渲染系统');
    await new Promise(requestAnimationFrame);
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,powerPreference:'high-performance'});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.15;
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.scene=new THREE.Scene();
    this.scene.background=new THREE.Color(0x9cb8c7);
    this.scene.fog=new THREE.FogExp2(0xb0c5cb,.00115);
    this.camera=new THREE.PerspectiveCamera(72,innerWidth/innerHeight,.07,2600);
    this.camera.rotation.order='YXZ';this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xd8efff,0x6d7250,2.2));
    this.sun=new THREE.DirectionalLight(0xffe4b2,3.5);
    this.sun.castShadow=true;this.sun.position.set(-180,250,120);
    Object.assign(this.sun.shadow.camera,{left:-70,right:70,top:70,bottom:-70,near:1,far:520});
    this.sun.shadow.mapSize.set(2048,2048);this.sun.shadow.normalBias=.045;this.sun.shadow.bias=-.00015;
    this.scene.add(this.sun,this.sun.target);
    this.hud.setLoading(.22,'正在生成海岛、聚落与道路');
    await new Promise(requestAnimationFrame);
    this.world=createWorld(this.scene,{seed:2026,quality:'high'});
    this.collision=new CollisionWorld(this.world.colliders,this.world.heightAt);
    this.hud.setLoading(.72,'正在准备装备与行动系统');
    await new Promise(requestAnimationFrame);
    this.dynamic=new THREE.Group();this.scene.add(this.dynamic);
    this.viewmodel=createViewmodel();this.camera.add(this.viewmodel.root);this.viewmodel.root.visible=false;
    this.menuHero=createSoldier({color:0x526154,player:true});this.scene.add(this.menuHero.root);
    const anchor=this.world.spawnPoints[Math.min(4,this.world.spawnPoints.length-1)];
    if(!anchor) throw new Error('Map has no player spawn positions');
    const free=this.findFree(anchor.x,anchor.z);
    this.heroAnchor={...free,y:this.world.heightAt(free.x,free.z)};
    this.menuHero.root.position.set(free.x,this.heroAnchor.y,free.z);
    this.menuHero.update({dt:0,speed:0,yaw:.5,weapon:'m416'});
    this.createZoneVisual();
    this.setQuality('high');this.resize();
    window.addEventListener('resize',this.resize);
    this.touchLayout=new TouchLayout(this.input,{onClose:()=>this.exitTouchLayout()});
    // 只有真正可用触屏控件时才提供布局编辑入口。
    if(this.touchLayout.enabled) document.getElementById('touch-layout-button')?.removeAttribute('hidden');
    this.bindRotateHint();
    if(this.portrait.addEventListener) this.portrait.addEventListener('change',()=>this.syncOrientation());
    else this.portrait.addListener(()=>this.syncOrientation());
    this.syncOrientation();
    this.hud.setLoading(1,'海岛已就绪');
    this.menu();
    this.lastFrame=performance.now();this.fps=60;
    requestAnimationFrame(this.frame);
  }

  findFree(x,z,radius=.4) {
    for(let ring=0;ring<20;ring++) for(let i=0;i<Math.max(1,ring*8);i++) {
      const angle=i/(ring*8||1)*Math.PI*2,px=x+Math.sin(angle)*ring*1.6,pz=z+Math.cos(angle)*ring*1.6;
      const y=this.world.heightAt(px,pz);
      if(y>1&&!this.collision.blocked(px,y+.04,pz,radius,1.8)) return {x:px,z:pz};
    }
    throw new Error(`No reachable dry ground near ${x},${z}`);
  }

  setQuality(quality) {
    if(!['high','low'].includes(quality)) throw new Error('Unknown graphics quality');
    this.options.quality=quality;
    if(!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,quality==='high'?1.5:1));
    this.renderer.shadowMap.enabled=quality==='high';
    this.renderer.setSize(innerWidth,innerHeight,false);
  }
  resize() {
    if(!this.renderer) return;
    this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth,innerHeight,false);
  }
  resetMatch() {
    for(const actor of this.actors) actor.model.dispose();
    for(const child of [...this.dynamic.children]) this.disposeObject(child);
    this.dynamic.clear();this.actors=[];this.loot=[];this.vehicles=[];this.grenades=[];this.particles=[];this.tracers=[];
    this.player=null;this.vehicle=null;this.plane=null;this.action=null;this.overlay(false,false,false);this.viewmodel.setWeapon(null);
    this.viewmodel.root.visible=false;this.zoneWall.visible=false;this.nextCircle.visible=false;
    this.input.reset();this.damageDone=0;this.kills=0;this.time=0;this.shotCooldown=0;this.recoil=0;this.boost=0;
    this.fireModeAuto=true;this.zoneWarn=0;this.lastZonePhase=-1;this.lastZoneMode='';this.actionErrorCooldown=0;
  }
  disposeObject(root) {
    const geometries=new Set(),materials=new Set();
    root.traverse(object=>{
      if(object.geometry) geometries.add(object.geometry);
      if(object.material) for(const mat of Array.isArray(object.material)?object.material:[object.material]) materials.add(mat);
    });
    for(const geometry of geometries) geometry.dispose();
    for(const material of materials) material.dispose();
    root.removeFromParent();
  }
  menu() {
    this.screen='menu';this.input.setActive(false);
    this.resetMatch();this.menuHero.root.visible=true;
    this.hud.setScreen('menu');this.audio.update({speed:0,vehicle:false,airborne:false});
    document.body.classList.remove('aiming','scoped','outside-zone','in-vehicle','airborne');
  }

  async start(options=this.options) {
    const name=String(options.name??'特种兵').trim().slice(0,16)||'特种兵';
    if(!['normal','hard'].includes(options.difficulty)||!['high','low'].includes(options.quality)) throw new Error('Invalid match settings');
    // 竖屏无法进行横屏射击，先引导旋转，避免开一局看不见的仗。
    if(this.touchMode&&this.portrait.matches) {
      this.hud.toast('请先把手机旋转到横向，再开始行动','warning');
      return;
    }
    // 先发起全屏 / 横屏锁定：必须在用户手势的有效期内调用，不能等 await 之后。
    this.enterFullscreenLandscape();
    await this.audio.start();
    this.options={difficulty:options.difficulty,quality:options.quality,name};
    this.resetMatch();this.setQuality(this.options.quality);
    this.rng=mulberry32(2026+(++this.matchCount)*97);
    this.zone=createZone(2026+this.matchCount*97);this.zoneInfo=zoneSnapshot(this.zone);
    this.spawnLoot();this.spawnVehicles();
    this.player=this.createActor(true,0,{x:-60,z:540});
    this.player.y=210;this.player.phase='plane';this.player.yaw=0;this.player.pitch=-.12;
    this.actors.push(this.player);
    for(let i=1;i<PARTICIPANTS;i++) {
      const spawn=this.world.spawnPoints[Math.floor(this.rng()*this.world.spawnPoints.length)];
      const position=this.findFree(spawn.x+(this.rng()-.5)*12,spawn.z+(this.rng()-.5)*12);
      const bot=this.createActor(false,i,position);
      bot.y=this.world.heightAt(bot.x,bot.z)+125+this.rng()*70;
      bot.phase='parachute';bot.release=2+this.rng()*18;bot.chute=true;
      this.actors.push(bot);
    }
    this.plane=createPlane();this.dynamic.add(this.plane);
    this.plane.position.set(-60,210,540);
    this.planeTime=0;this.phase='plane';this.screen='playing';this.menuHero.root.visible=false;
    this.zoneWall.visible=true;this.nextCircle.visible=true;
    this.hud.setScreen('playing');this.input.setActive(true);this.touchLayout?.apply();this.input.lock();
    this.hud.toast(this.touchMode?'行动开始 · 选择落点，点右侧「跳伞」离开运输机':'行动开始 · 选择落点，按 F 或空格离开运输机');
    this.hud.feed('运输机已进入海岛空域 · 本局 48 名参赛者');
    this.updateZoneVisual();this.updateHud();
  }

  createActor(isPlayer,id,position) {
    const model=createSoldier({color:isPlayer?0x526252:[0x59654d,0x75644e,0x53656a,0x62626e][id%4],player:isPlayer});
    this.dynamic.add(model.root);
    return {id,isPlayer,name:isPlayer?this.options.name:`${BOT_NAMES[id%BOT_NAMES.length]}${String(id).padStart(2,'0')}`,
      x:position.x,z:position.z,y:0,yaw:0,pitch:0,vy:0,health:100,inventory:createInventory(),model,
      phase:'ground',chute:false,alive:true,crouch:false,prone:false,speed:0,thinkIn:this.rng()*1.2,
      target:null,goal:null,shotIn:this.rng(),reloadIn:0,roamIn:0,detourIn:0,stuck:0,deadTime:0};
  }

  spawnLoot() {
    const ids=Object.keys(WEAPONS);
    this.world.lootSpawns.forEach((point,index)=>{
      const spot=this.findFree(point.x,point.z);
      if(index%3===0) {
        const id=ids[Math.floor(this.rng()*ids.length)];
        this.addLootObject({kind:'weapon',id},spot.x,spot.z);
        this.addLootObject({kind:'ammo',id:WEAPONS[id].ammo,amount:60},spot.x+.7,spot.z+.35);
      } else {
        const r=this.rng();
        const item=r<.22?{kind:'medkit',amount:1}:r<.4?{kind:'boost',amount:1}:r<.62?{kind:'armor',level:1+(this.rng()>.7?1:0)}:
          r<.8?{kind:'helmet',level:1+(this.rng()>.8?1:0)}:r<.92?{kind:'grenade',amount:1}:{kind:'ammo',id:['556','762','9mm'][index%3],amount:45};
        this.addLootObject(item,spot.x,spot.z);
      }
    });
  }
  addLootObject(item,x,z) {
    const mesh=createLootMesh(item),y=this.world.heightAt(x,z)+.16;
    mesh.position.set(x,y,z);this.dynamic.add(mesh);
    const loot={item,x,y,z,mesh,active:true,phase:this.rng()*Math.PI*2};this.loot.push(loot);return loot;
  }
  spawnVehicles() {
    for(const location of this.world.locations.filter((_,i)=>i%2===0).slice(0,5)) {
      const spot=this.findFree(location.x+28,location.z+28,1.7);
      const root=createVehicle();const y=this.world.heightAt(spot.x,spot.z);
      root.position.set(spot.x,y,spot.z);this.dynamic.add(root);
      this.vehicles.push({root,x:spot.x,z:spot.z,y,yaw:0,speed:0});
    }
  }
  pause() {
    if(this.screen!=='playing') return;
    this.screen='paused';this.input.setActive(false);this.overlay(false,false,false);this.hud.setScreen('paused');
    this.audio.update({speed:0,vehicle:false,airborne:false});
  }
  /** 横屏是本作在手机端的目标形态：竖屏显示旋转提示，对局中自动暂停避免误操作。 */
  syncOrientation() {
    const portrait=this.touchMode&&this.portrait.matches;
    document.body.classList.toggle('portrait',portrait);
    if(portrait&&this.screen==='playing') this.pause();
  }
  /**
   * 请求全屏并尝试锁定横屏。必须在用户手势的有效期内同步调用——
   * 先 await 再请求会丢失手势许可。iOS 不支持锁定，由竖屏提示兜底。
   */
  enterFullscreenLandscape() {
    if(!this.touchMode) return;
    const element=document.documentElement;
    const request=element.requestFullscreen||element.webkitRequestFullscreen;
    try {
      if(request&&!document.fullscreenElement&&!document.webkitFullscreenElement) {
        const promise=request.call(element);
        if(promise?.then) promise.then(()=>this.lockLandscape()).catch(()=>{});
        return;
      }
    } catch { /* 不支持全屏时直接尝试锁定横屏 */ }
    this.lockLandscape();
  }
  lockLandscape() {
    try {
      const promise=screen.orientation?.lock?.('landscape');
      if(promise?.catch) promise.catch(()=>{});
    } catch { /* 桌面与 iOS 不支持，静默忽略 */ }
  }
  /** 从暂停菜单进入布局编辑：先离开对局输入态，编辑期间由 TouchLayout 接管指针。 */
  editTouchLayout() {
    if(!this.touchLayout||!this.touchLayout.enabled) return;
    if(this.touchLayout.editing) return;
    if(!this.touchLayout.open()) {this.hud.toast('当前设备未启用触屏控件，无法编辑布局','warning');return;}
    this.hud.setScreen('playing');this.screen='editing';
  }
  /** 布局编辑结束：回到暂停菜单，避免带着编辑态直接继续对局。 */
  exitTouchLayout() {
    if(this.screen!=='editing') return;
    this.screen='paused';this.input.setActive(false);this.hud.setScreen('paused');
    this.touchLayout.apply();
  }
  async resume() {
    if(this.screen!=='paused') return;
    // 竖屏下不允许回到对局：否则游戏会在提示遮罩后面继续跑。
    if(this.touchMode&&this.portrait.matches) {
      this.hud.toast('请先把手机旋转到横向，再返回战场','warning');
      return;
    }
    // 同样要在用户手势窗口内请求全屏与横屏锁定。
    this.enterFullscreenLandscape();
    await this.audio.start();
    if(this.screen!=='paused') return;
    this.screen='playing';this.hud.setScreen('playing');this.input.setActive(true);this.input.lock();
  }
  overlay(map,inventory,help) {
    this.mapOpen=map;this.inventoryOpen=inventory;this.helpOpen=help;
    this.hud.setMap(map);this.hud.setInventory(inventory);this.hud.setHelp(help);
    if(this.input.active) this.input.setCursor(map||inventory||help);
  }

  frame(now) {
    if(this.screen==='error') return;
    try {
      const frameTime=Math.max(0,(now-this.lastFrame)/1000);
      const dt=Math.min(.05,frameTime);this.lastFrame=now;this.elapsed+=dt;
      this.fps=damp(this.fps,1/Math.max(.001,frameTime),2,dt);
      const controls=this.input.sample();
      if(this.screen==='playing') {
        this.commands(controls);
        if(this.screen==='playing') this.step(dt,controls);
      }
      this.world.update(dt,this.elapsed);
      this.updateVisuals(dt);
      this.renderer.render(this.scene,this.camera);
      requestAnimationFrame(this.frame);
    } catch(error) {this.fatal(error);}
  }
  fatal(error) {
    console.error(error);this.screen='error';this.input.setActive(false);
    const panel=document.getElementById('fatal-error');
    if(panel) {panel.hidden=false;panel.textContent=`游戏运行出错：${error.message}。请刷新重试，详细信息见控制台。`;panel.style.display='block';}
    this.audio.update({speed:0,vehicle:false,airborne:false});
  }

  commands(controls) {
    const pressed=controls.pressed,p=this.player;
    if(pressed.has('pause')) {if(this.mapOpen||this.inventoryOpen||this.helpOpen) this.overlay(false,false,false);else this.pause();return;}
    if(pressed.has('map')) this.overlay(!this.mapOpen,false,false);
    if(pressed.has('inventory')) this.overlay(false,!this.inventoryOpen,false);
    if(pressed.has('help')) this.overlay(false,false,!this.helpOpen);
    if(this.mapOpen||this.inventoryOpen||this.helpOpen) return;
    if(pressed.has('view')) this.thirdPerson=!this.thirdPerson;
    if(p.phase==='plane') {if(pressed.has('airdrop')||pressed.has('interact')||pressed.has('jump')) this.jumpFromPlane();return;}
    if(p.phase==='parachute') {if(pressed.has('airdrop')||pressed.has('interact')||pressed.has('jump')) this.openChute();return;}
    if(pressed.has('crouch')) this.setPosture('crouch');
    if(pressed.has('prone')) this.setPosture('prone');
    if(pressed.has('slot1')) this.selectSlot(0);
    if(pressed.has('slot2')) this.selectSlot(1);
    if(pressed.has('nextSlot')) this.selectSlot(1-p.inventory.active);
    if(pressed.has('fireMode')&&this.weapon()?.automatic) this.setFireMode(!this.fireModeAuto);
    if(pressed.has('reload')) this.beginReload();
    if(pressed.has('heal')) this.beginHeal(false);
    if(pressed.has('boost')) this.beginHeal(true);
    if(pressed.has('grenade')) this.throwGrenade();
    if(pressed.has('interact')||pressed.has('vehicle')) this.interact();
    if(pressed.has('jump')&&!this.vehicle&&!p.prone&&p.y<=this.collision.floorAt(p.x,p.z,p.y+.08)+.08&&!this.collision.blocked(p.x,p.y+.01,p.z,.36,1.75)) {p.vy=5.2;p.crouch=false;this.action=null;}
    this.firePressed=pressed.has('fire');
  }

  step(dt,controls) {
    this.time+=dt;
    this.zone=advanceZone(this.zone,dt);this.zoneInfo=zoneSnapshot(this.zone);
    this.shotCooldown=Math.max(0,this.shotCooldown-dt);this.recoil=damp(this.recoil,0,12,dt);
    this.actionErrorCooldown=Math.max(0,this.actionErrorCooldown-dt);
    const p=this.player,blocked=this.mapOpen||this.inventoryOpen||this.helpOpen;
    if(!blocked) {
      p.yaw-=controls.dx*.0022*(controls.aim?.6:1);
      p.pitch=clamp(p.pitch-controls.dy*.0022*(controls.aim?.6:1),-1.43,1.35);
    }
    const held=blocked?new Set():controls.held;
    // 键盘为离散 -1/0/1，触屏摇杆为连续量；两者相加后统一夹取，互不干扰。
    const move=this.mergeMove(held,controls.move);
    this.aim=!blocked&&controls.aim&&p.phase==='ground'&&!this.vehicle;
    this.planeTime+=dt;
    if(this.plane) {this.plane.position.z=540-this.planeTime*42;this.plane.visible=this.planeTime<43;}
    if(p.phase==='plane') {
      p.x=this.plane.position.x;p.y=this.plane.position.y;p.z=this.plane.position.z;
      if(this.planeTime>24) this.jumpFromPlane();
    } else if(p.phase==='parachute') this.updateParachute(p,dt,held,move);
    else if(this.vehicle) this.drive(dt,held,move);
    else this.movePlayer(dt,held,move);
    this.phase=p.phase;
    if(this.action) {
      const moving=move.x!==0||move.y!==0;
      if((this.action.type!=='reload'&&moving)||held.has('fire')) this.cancelAction();
      else this.updateAction(dt);
    }
    if(!blocked&&p.phase==='ground'&&!this.vehicle&&!this.action) {
      const weapon=this.weapon(p);
      if((weapon?.automatic&&this.fireModeAuto&&held.has('fire'))||this.firePressed) this.firePlayer();
    }
    this.firePressed=false;
    if(this.boost>0) {this.boost=Math.max(0,this.boost-dt*1.3);p.health=Math.min(100,p.health+dt*1.15);}
    for(const bot of this.actors) {if(this.screen!=='playing')break;if(!bot.isPlayer&&bot.alive)this.updateBot(bot,dt);}
    if(this.screen!=='playing') return;
    this.updateGrenades(dt);
    for(const actor of this.actors) {
      if(!actor.alive||actor.phase==='plane') continue;
      if(isOutsideZone(actor.x,actor.z,this.zoneInfo)) this.hurt(actor,this.zoneInfo.damage*dt,null,false,true);
      if(actor.y<-.7&&actor.phase==='ground') this.hurt(actor,12*dt,null,false,true);
    }
    if(this.screen!=='playing') return;
    const outside=isOutsideZone(p.x,p.z,this.zoneInfo);
    document.body.classList.toggle('outside-zone',outside);
    document.body.classList.toggle('airborne',p.phase==='plane'||p.phase==='parachute');
    this.zoneWarn-=dt;
    if(outside&&this.zoneWarn<=0) {this.hud.toast('你在信号区外！立即进入安全区','warning');this.audio.zone();this.zoneWarn=8;}
    if(this.lastZonePhase!==this.zoneInfo.phase||this.lastZoneMode!==this.zoneInfo.mode) {
      this.lastZonePhase=this.zoneInfo.phase;this.lastZoneMode=this.zoneInfo.mode;
      this.hud.feed(this.zoneInfo.mode==='shrinking'?'信号区正在收缩，注意转移':`第 ${this.zoneInfo.phase+1} 阶段 · 新的安全区已标记`);
      this.updateZoneVisual();
    }
    this.zoneVisualTimer=(this.zoneVisualTimer||0)-dt;
    if(this.zoneVisualTimer<=0) {this.updateZoneVisual();this.zoneVisualTimer=.3;}
    if(this.actors.filter(a=>a.alive).length===1&&p.alive) this.finish(true);
    this.hudTimer=(this.hudTimer||0)-dt;
    if(this.hudTimer<=0) {this.updateHud();this.hudTimer=.07;}
    this.audio.update({speed:p.speed,vehicle:!!this.vehicle,airborne:p.phase!=='ground'});
  }

  /** 切换射击模式。桌面端 B 键，手机端在暂停菜单里选；仅对全自动武器有意义。 */
  setFireMode(auto) {
    this.fireModeAuto=!!auto;
    this.hud.toast(this.fireModeAuto?'射击模式：全自动':'射击模式：单发');
  }
  jumpFromPlane() {
    const p=this.player;if(p.phase!=='plane') return;
    p.phase='parachute';p.chute=false;p.vy=-16;p.pitch=-.42;
    this.hud.toast(this.touchMode?'摇杆调整落点 · 开伞按钮提前开伞 · 低空自动开伞':'WASD 调整落点 · F 提前开伞 · 低空自动开伞');
    this.hud.feed('你已离开运输机');
  }
  /** 手动开伞。桌面端 F/空格，手机端用跳伞按钮；重复触发无副作用。 */
  openChute() {
    const p=this.player;
    if(p.phase!=='parachute'||p.chute) return;
    p.chute=true;
    this.hud.toast('降落伞已展开 · 摇杆微调落点');
  }
  /** 竖屏提示上的按钮：进入全屏并尝试锁定横屏。遮罩挂在 body 下、不在 #hud 内，需单独接线。 */
  bindRotateHint() {
    const button=document.getElementById('rotate-fullscreen');
    if(!button) return;
    button.addEventListener('click',()=>this.enterFullscreenLandscape());
  }
  updateParachute(actor,dt,held=new Set(),move={x:0,y:0}) {
    const ground=this.collision.floorAt(actor.x,actor.z,actor.y);
    if(actor.y-ground<65) actor.chute=true;
    actor.vy=damp(actor.vy,actor.chute?-7:-29,3,dt);
    let forward=move.y,side=move.x;
    if(!actor.chute) forward+=.25;
    const speed=actor.chute?12:18,angle=actor.yaw;
    const next=this.collision.move(actor,(-Math.sin(angle)*forward+Math.cos(angle)*side)*speed*dt,(-Math.cos(angle)*forward-Math.sin(angle)*side)*speed*dt);
    actor.x=next.x;actor.z=next.z;actor.speed=Math.hypot(forward,side)*speed;
    const vertical=this.collision.vertical(actor,actor.vy,dt);
    actor.y=vertical.y;actor.vy=vertical.vy;
    if(vertical.grounded) {
      actor.phase='ground';actor.chute=false;
      if(actor.isPlayer) {this.hud.toast(this.touchMode?'落地！靠近物资点按「互动」搜集 · 用摇杆移动':'落地！按 F 搜集武器与物资 · H 查看完整键位');this.hud.feed('已进入地面作战');}
    }
  }

  setPosture(posture) {
    const p=this.player,crouch=posture==='crouch'&&!p.crouch,prone=posture==='prone'&&!p.prone;
    const height=prone?.55:crouch?1.2:1.75;
    if(this.collision.blocked(p.x,p.y+.01,p.z,.36,height)){this.hud.toast('上方空间不足，无法起身','warning');return;}
    p.crouch=crouch;p.prone=prone;this.action=null;
  }
  /** 把键盘方向键与摇杆位移合成一个长度不超过 1 的移动向量（y 前为正，x 右为正）。 */
  mergeMove(held, stick) {
    const forward=Number(held.has('forward'))-Number(held.has('back'));
    const side=Number(held.has('right'))-Number(held.has('left'));
    let x=side+(stick?.x||0),y=forward+(stick?.y||0);
    const length=Math.hypot(x,y);
    if(length>1){x/=length;y/=length;}
    return {x,y};
  }
  movePlayer(dt,held,move={x:0,y:0}) {
    const p=this.player;
    const wasGrounded=p.vy<=0&&p.y<=this.collision.floorAt(p.x,p.z,p.y+.05)+.05;
    let forward=move.y,side=move.x;
    const length=Math.hypot(forward,side);if(length>1){forward/=length;side/=length;}
    const sprint=held.has('sprint')&&!this.aim&&!p.crouch&&!p.prone;
    const maxSpeed=p.prone?1.6:p.crouch?2.8:held.has('walk')?2.5:this.aim?3.4:sprint?7.5:5.4;
    // 摇杆推杆幅度决定速度：轻推慢走、推满全速，键盘保持原速。
    const analogue=Math.min(1,Math.hypot(forward,side));
    // 加速度模型：起步有提速感、松手有短暂滑行，不再是「松手即停」的瞬移。
    // 原先直接按 maxSpeed*dt 位移，再叠上摇杆幅度线性缩放，手机上实测只有 1~2 m/s，
    // 这是「移动非常慢」的根因。参数借鉴 cf-transport-ship/src/actor.js（RUN=5.7、加速度 11、阻尼 9），
    // 但把加速度改成绝对值 m/s²（cf 的 11*dt*wishSpeed 在高速时会瞬间到位，几乎感觉不到提速）。
    const wishSpeed=maxSpeed*analogue*(this.boost>50?1.06:1);
    const horizontal=Math.hypot(forward,side);
    const wishX=horizontal>0?forward/horizontal:0, wishZ=horizontal>0?side/horizontal:0;
    p.velX=p.velX||0;p.velZ=p.velZ||0;
    const grounded=p.vy===0;
    if(grounded){
      // 加速朝 wishSpeed 逼近，但不越过它；没有输入时按阻尼滑行到 0。
      if(horizontal>0){
        const speed=Math.hypot(p.velX,p.velZ);
        if(speed<wishSpeed){
          const acc=Math.min(GROUND_ACCEL*dt,wishSpeed-speed);
          p.velX+=wishX*acc;p.velZ+=wishZ*acc;
        } else if(speed-wishSpeed>GROUND_DAMP*dt){
          // 只有明显超出期望速度（例如冲刺降成步行）才用阻尼收敛；
          // 留出一帧阻尼步长的死区，否则加速与阻尼会在稳态上限附近来回抖动。
          const keep=Math.max(0,speed-GROUND_DAMP*dt)/speed;
          p.velX*=keep;p.velZ*=keep;
        }
      } else {
        const speed=Math.hypot(p.velX,p.velZ);
        if(speed>0){const keep=Math.max(0,speed-GROUND_DAMP*dt)/speed;p.velX*=keep;p.velZ*=keep;}
      }
    } else if(horizontal>0){
      // 空中控制很弱，只允许小幅修正，避免跳跃时像地面一样灵活。
      const speed=Math.hypot(p.velX,p.velZ);
      if(speed<wishSpeed){
        const acc=Math.min(AIR_ACCEL*dt,wishSpeed-speed);
        p.velX+=wishX*acc;p.velZ+=wishZ*acc;
      }
    }
    const dx=(-Math.sin(p.yaw)*p.velX+Math.cos(p.yaw)*p.velZ)*dt;
    const dz=(-Math.cos(p.yaw)*p.velX-Math.sin(p.yaw)*p.velZ)*dt;
    const next=this.collision.move(p,dx,dz,.36,p.prone?.55:p.crouch?1.2:1.75);
    // 撞墙后把速度投影掉，否则会持续贴着墙「顶」出速度。
    const movedX=next.x-p.x, movedZ=next.z-p.z;
    if(dt>0){
      p.speed=Math.hypot(movedX,movedZ)/dt;
      if(Math.hypot(movedX,movedZ)<Math.hypot(dx,dz)*.35){p.velX*=.2;p.velZ*=.2;}
    } else p.speed=0;
    p.x=next.x;p.z=next.z;
    const floor=this.collision.floorAt(p.x,p.z,p.y+.65);
    if(wasGrounded&&floor>p.y&&floor-p.y<=.65) p.y=floor;
    p.vy-=18*dt;
    const vertical=this.collision.vertical(p,p.vy,dt,p.prone?.55:p.crouch?1.2:1.75);
    p.y=vertical.y;p.vy=vertical.vy;
    if(vertical.impactSpeed>11) this.hurt(p,(vertical.impactSpeed-10)*5,null);
    this.lean=damp(this.lean||0,held.has('leanLeft')?.3:held.has('leanRight')?-.3:0,10,dt);
    this.stepTimer=(this.stepTimer||0)-dt;
    if(p.speed>1&&p.vy===0&&this.stepTimer<=0) {this.audio.step(p.speed);this.stepTimer=sprint?.29:.42;}
  }
  weapon(actor=this.player) {const slot=actor.inventory.slots[actor.inventory.active];return slot?WEAPONS[slot.id]:null;}
  selectSlot(index) {
    this.player.inventory={...this.player.inventory,active:index};this.action=null;this.recoil=0;
    this.viewmodel.setWeapon(this.player.inventory.slots[index]?.id||null);
  }
  beginReload() {
    const p=this.player,w=this.weapon(),slot=p.inventory.slots[p.inventory.active];
    if(!w||this.action||this.vehicle) return;
    if(slot.rounds===w.magSize) return;
    if(p.inventory.ammo[w.ammo]===0) {this.hud.toast('没有对应的备用弹药','warning');return;}
    this.action={type:'reload',label:'正在换弹',total:w.reloadTime,remaining:w.reloadTime,slot:p.inventory.active};
    this.audio.reload();
  }
  beginHeal(boost) {
    const p=this.player,key=boost?'boosts':'medkits';
    if(p.phase!=='ground'||this.action||this.vehicle) return;
    if(!p.inventory[key]) {this.hud.toast(boost?'背包内没有能量饮料':'背包内没有急救包','warning');return;}
    if(!boost&&p.health>=100) {this.hud.toast('当前生命值已满');return;}
    const duration=boost?3:5;
    this.action={type:boost?'boost':'heal',label:boost?'正在使用能量饮料':'正在使用急救包',total:duration,remaining:duration};
  }
  cancelAction() {if(this.action){this.action=null;this.hud.toast('动作已取消');}}
  updateAction(dt) {
    this.action.remaining-=dt;if(this.action.remaining>0) return;
    const action=this.action,p=this.player;this.action=null;
    if(action.type==='reload'&&action.slot===p.inventory.active) p.inventory=reloadWeapon(p.inventory);
    if(action.type==='heal') {p.inventory={...p.inventory,medkits:p.inventory.medkits-1};p.health=Math.min(100,p.health+75);this.audio.pickup();}
    if(action.type==='boost') {p.inventory={...p.inventory,boosts:p.inventory.boosts-1};this.boost=100;this.audio.pickup();}
  }

  nearestLoot(actor,limit=3.1) {
    let best=null,bestDistance=limit;
    for(const loot of this.loot) {
      if(!loot.active) continue;
      const d=dist(actor,loot);
      if(d>=bestDistance||Math.abs(actor.y-loot.y)>2.5) continue;
      // 房区里物品常被家具或箱子挡住，要求视线会让站在旁边却拾取不到；手动拾取同样不该要求视线。
      best=loot;bestDistance=d;
    }
    return best;
  }
  /** 收集交互范围内的所有物品（按距离从近到远）。 */
  nearbyLoot(actor,limit=2.6) {
    const found=[];
    for(const loot of this.loot) {
      if(!loot.active) continue;
      const d=dist(actor,loot);
      if(d<limit&&Math.abs(actor.y-loot.y)<2.5) found.push({loot,d});
    }
    found.sort((a,b)=>a.d-b.d);
    return found.map(entry=>entry.loot);
  }
  /** 交互拾取：范围内逐个收，直到背包装不下为止。仍然需要玩家主动按「互动」。 */
  pickupNearby(actor) {
    const items=this.nearbyLoot(actor);
    if(!items.length) return false;
    // pickup() 会清空 this.action 以打断原先动作；拾取本身是主动行为，这里保持原语义。
    let taken=0;
    for(const loot of items) if(this.pickup(actor,loot)) taken++;
    return taken>0;
  }
  interact() {
    const p=this.player;if(p.phase!=='ground') return;
    if(this.vehicle) {this.exitVehicle();return;}
    // 一次交互收完附近所有能装的物品：房区里装备成片散落，挨个点太碎。
    if(this.pickupNearby(p)) return;
    const vehicle=this.vehicles.find(v=>dist(v,p)<4.5);
    if(vehicle) {this.vehicle=vehicle;this.action=null;p.prone=false;p.crouch=false;this.hud.toast(this.touchMode?'摇杆控制油门与转向 · 『互动』下车':'W/S 油门与倒车 · A/D 转向 · 空格刹车 · F 下车');document.body.classList.add('in-vehicle');}
  }
  pickup(actor,loot) {
    const result=addLoot(actor.inventory,loot.item);
    if(!result.accepted) {if(actor.isPlayer)this.hud.toast(result.message,'warning');return false;}
    const previous=actor.inventory.slots[actor.inventory.active];
    const before=actor.inventory;
    actor.inventory=result.inventory;
    let remainder=0;
    if(loot.item.kind==='ammo') remainder=loot.item.amount-(actor.inventory.ammo[loot.item.id]-before.ammo[loot.item.id]);
    const stackField={medkit:'medkits',boost:'boosts',grenade:'grenades'}[loot.item.kind];
    if(stackField) remainder=loot.item.amount-(actor.inventory[stackField]-before[stackField]);
    if(loot.item.kind==='weapon'&&before.slots.some(slot=>slot?.id===loot.item.id)) {
      const weapon=WEAPONS[loot.item.id];
      remainder=(loot.item.rounds??weapon.magSize)-(actor.inventory.ammo[weapon.ammo]-before.ammo[weapon.ammo]);
    }
    if(remainder>0) loot.item={...loot.item,...(loot.item.kind==='weapon'?{rounds:remainder}:{amount:remainder})};
    else {loot.active=false;loot.mesh.visible=false;}
    if(actor.isPlayer) {
      this.audio.pickup();this.hud.toast(result.message);
      this.viewmodel.setWeapon(actor.inventory.slots[actor.inventory.active]?.id||null);
      this.action=null;
    }
    // Replacement preserves the displaced magazine for both players and AI.
    if(loot.item.kind==='weapon'&&previous&&previous.id!==loot.item.id&&!actor.inventory.slots.some(slot=>slot?.id===previous.id)) {
      this.addLootObject({kind:'weapon',id:previous.id,rounds:previous.rounds},actor.x+.6,actor.z+.4);
    }
    return true;
  }

  firePlayer() {
    if(this.shotCooldown>0) return;
    const p=this.player,w=this.weapon(),slot=p.inventory.slots[p.inventory.active];
    if(!w) {
      this.shotCooldown=.55;this.recoil=.1;
      const target=this.actors.find(a=>a!==p&&a.alive&&dist(p,a)<2.3&&this.collision.visible(eye(p),eye(a))&&dirFor(p.yaw).dot(new THREE.Vector3(a.x-p.x,0,a.z-p.z).normalize())>.65);
      if(target) {this.hurt(target,22,p);this.audio.hit(false);this.hud.hit(false);}
      return;
    }
    if(slot.rounds<=0) {this.beginReload();if(!this.action&&this.actionErrorCooldown===0){this.hud.toast('弹匣已空，需要搜集弹药','warning');this.actionErrorCooldown=2;}return;}
    p.inventory=consumeRound(p.inventory);this.shotCooldown=w.fireInterval;
    const spread=w.spread*(this.aim?.22:1)*(p.speed>1?1.9:1)*(p.crouch?.75:p.prone?.4:1);
    const direction=dirFor(p.yaw+(this.rng()-.5)*spread,p.pitch+(this.rng()-.5)*spread);
    this.shoot(p,eye(p),direction,w);this.recoil=w.id==='kar98'?.095:.045;
    p.pitch=clamp(p.pitch+(w.id==='kar98'?.027:.01)*(this.aim?.6:1),-1.43,1.35);
    this.audio.shot(w.id,1);
  }
  shoot(shooter,origin,direction,weapon) {
    const wallDistance=this.collision.ray(origin,direction,weapon.range);
    let nearest=wallDistance,victim=null,headshot=false;
    for(const actor of this.actors) {
      if(!actor.alive||actor===shooter||actor.phase==='plane'||actor.release>this.time) continue;
      const head={x:actor.x,y:actor.y+(actor.prone?.42:actor.crouch?1.08:1.57),z:actor.z};
      const body={x:actor.x,y:actor.y+(actor.prone?.3:actor.crouch?.64:.95),z:actor.z};
      const h=raySphereDistance(origin,direction,head,.22,nearest);
      const b=raySphereDistance(origin,direction,body,actor.prone?.55:.46,nearest);
      if(h!==null&&(b===null||h<=b+.25)) {nearest=h;victim=actor;headshot=true;}
      else if(b!==null) {nearest=b;victim=actor;headshot=false;}
    }
    const end=new THREE.Vector3(origin.x,origin.y,origin.z).addScaledVector(direction,nearest);
    if(shooter.isPlayer||dist(shooter,this.player)<=BOT_COMBAT_DISTANCE) this.tracer(origin,end,shooter.isPlayer?0xffd593:0xffaa64);
    if(victim) {
      const raw=weapon.damage*(headshot?weapon.headMultiplier:1)*Math.max(.65,1-nearest/900);
      this.hurt(victim,raw,shooter,headshot);
      this.burst(end,headshot?0xffc970:0xa94735,5,.8);
      if(shooter.isPlayer) {this.hud.hit(headshot);this.audio.hit(headshot);}
    } else if(nearest<weapon.range) this.burst(end,0xdcc9a0,3,.45);
  }
  hurt(actor,amount,attacker,headshot=false,zone=false) {
    if(!actor.alive||this.screen!=='playing') return;
    const previous=actor.health;
    const result=applyDamage({health:actor.health,armor:actor.inventory.armor,helmet:actor.inventory.helmet},amount,{headshot,zone});
    actor.health=result.health;
    if(attacker===this.player) this.damageDone+=previous-actor.health;
    if(actor.isPlayer) {
      if(!zone&&amount>0) {this.action=null;this.hud.damage(attacker?Math.atan2(attacker.x-actor.x,attacker.z-actor.z)-actor.yaw:0);}
    } else if(attacker) {actor.target=dist(actor,attacker)<=BOT_COMBAT_DISTANCE?attacker:null;actor.thinkIn=.15;}
    if(actor.health<=0) this.kill(actor,attacker,headshot,zone);
  }
  kill(actor,attacker,headshot,zone) {
    actor.alive=false;actor.health=0;actor.speed=0;actor.deadTime=this.time;actor.model.update({dt:0,dead:true,yaw:actor.yaw});
    if(attacker===this.player) {this.kills++;this.hud.toast(`${headshot?'爆头淘汰':'淘汰'} ${actor.name}`);}
    const message=zone?`${actor.name} 在信号区外被淘汰`:`${attacker?.name||'环境'} ${headshot?'爆头淘汰':'淘汰了'} ${actor.name}`;
    this.hud.feed(message);
    if(!actor.isPlayer) {
      for(const slot of actor.inventory.slots) if(slot) this.addLootObject({kind:'weapon',id:slot.id,rounds:slot.rounds},actor.x+(this.rng()-.5),actor.z+(this.rng()-.5));
      for(const [id,amount] of Object.entries(actor.inventory.ammo)) if(amount>0) this.addLootObject({kind:'ammo',id,amount},actor.x+.6,actor.z+.6);
      for(const [kind,field] of [['medkit','medkits'],['boost','boosts'],['grenade','grenades']]) if(actor.inventory[field])this.addLootObject({kind,amount:actor.inventory[field]},actor.x+(this.rng()-.5)*1.5,actor.z+(this.rng()-.5)*1.5);
      for(const kind of ['armor','helmet'])if(actor.inventory[kind])this.addLootObject({kind,level:actor.inventory[kind]},actor.x+(this.rng()-.5)*1.5,actor.z+(this.rng()-.5)*1.5);
    } else this.finish(false);
  }

  updateBot(bot,dt) {
    if(this.time<bot.release) return;
    if(bot.phase==='parachute') {this.updateParachute(bot,dt);return;}
    bot.shotIn-=dt;bot.thinkIn-=dt;bot.roamIn-=dt;bot.detourIn-=dt;
    if(bot.reloadIn>0) {
      bot.reloadIn-=dt;
      if(bot.reloadIn<=0) bot.inventory=reloadWeapon(bot.inventory);
    }
    if(bot.thinkIn<=0) {
      bot.thinkIn=.65+this.rng()*.4;
      const usable=bot.inventory.slots.findIndex(slot=>slot&&(slot.rounds>0||bot.inventory.ammo[WEAPONS[slot.id].ammo]>0));
      const current=bot.inventory.slots[bot.inventory.active];
      if(usable>=0&&(!current||(current.rounds===0&&bot.inventory.ammo[WEAPONS[current.id].ammo]===0))) bot.inventory={...bot.inventory,active:usable};
      const w=this.weapon(bot);
      bot.target=null;
      if(w&&usable>=0) {
        let nearest=Math.min(w.range,this.options.difficulty==='hard'?170:135);
        for(const other of this.actors) {
          if(other===bot||!other.alive||other.phase!=='ground') continue;
          const d=dist(bot,other);
          if(d<nearest&&this.collision.visible(eye(bot),eye(other))) {nearest=d;bot.target=other;}
        }
      }
      if(!bot.target) {
        let best=null,score=Infinity;
        for(const loot of this.loot) {
          if(!loot.active) continue;
          const need=!w?loot.item.kind==='weapon':(loot.item.kind==='ammo'&&loot.item.id===w.ammo&&bot.inventory.ammo[w.ammo]<80)||(usable<0&&loot.item.kind==='weapon'&&(loot.item.rounds??WEAPONS[loot.item.id].magSize)>0);
          if(!need) continue;
          const d=dist(bot,loot);
          if(d<score) {score=d;best=loot;}
        }
        bot.lootTarget=best;
      }
    }
    if(bot.target&&(!bot.target.alive||dist(bot,bot.target)>Math.min(BOT_COMBAT_DISTANCE,this.weapon(bot)?.range||0))) bot.target=null;
    const outside=isOutsideZone(bot.x,bot.z,this.zoneInfo);
    const nextDistance=Math.hypot(bot.x-this.zoneInfo.nextX,bot.z-this.zoneInfo.nextZ);
    const relocate=outside||(this.zoneInfo.mode==='shrinking'&&nextDistance>this.zoneInfo.nextRadius*.86);
    let goal,speed=3.9;
    if(relocate) {goal={x:this.zoneInfo.nextX,z:this.zoneInfo.nextZ};speed=6.2;}
    else if(bot.target) goal=bot.target;
    else if(bot.lootTarget?.active) goal=bot.lootTarget;
    else {
      if(bot.roamIn<=0||!bot.goal||dist(bot,bot.goal)<5) {
        const angle=this.rng()*Math.PI*2,radius=Math.min(this.zoneInfo.radius*.75,180+this.rng()*180);
        bot.goal={x:this.zoneInfo.x+Math.sin(angle)*radius,z:this.zoneInfo.z+Math.cos(angle)*radius};
        bot.roamIn=12+this.rng()*10;
      }
      goal=bot.goal;
    }
    let dx=goal.x-bot.x,dz=goal.z-bot.z,len=Math.hypot(dx,dz);
    if(bot.target&&!relocate) {
      const targetDistance=dist(bot,bot.target);
      if(targetDistance<14) {dx=-dx;dz=-dz;}
      else if(targetDistance<45) {
        const side=Math.sin(this.time*.65+bot.id)>.0?1:-1;
        [dx,dz]=[-dz*side,dx*side];speed=2.4;
      }
      bot.yaw=Math.atan2(-(bot.target.x-bot.x),-(bot.target.z-bot.z));
      const w=this.weapon(bot),slot=bot.inventory.slots[bot.inventory.active];
      if(w&&bot.shotIn<=0&&bot.reloadIn<=0&&this.collision.visible(eye(bot),eye(bot.target))) {
        if(slot.rounds===0) {if(bot.inventory.ammo[w.ammo]>0)bot.reloadIn=w.reloadTime;else bot.target=null;}
        else {
          bot.inventory=consumeRound(bot.inventory);
          bot.shotIn=w.fireInterval*(this.options.difficulty==='hard'?1.7:2.5)+this.rng()*.22;
          const origin=eye(bot),target=eye(bot.target);
          const direction=new THREE.Vector3(target.x-origin.x,target.y-origin.y-.4,target.z-origin.z).normalize();
          const spread=this.options.difficulty==='hard'?.033:.064;
          direction.x+=(this.rng()-.5)*spread;direction.y+=(this.rng()-.5)*spread;direction.z+=(this.rng()-.5)*spread;direction.normalize();
          this.shoot(bot,origin,direction,w);
          const distance=dist(bot,this.player);
          if(distance<=BOT_COMBAT_DISTANCE) this.audio.shot(w.id,Math.max(.025,(1-distance/BOT_COMBAT_DISTANCE)*.3));
        }
      }
    } else if(len>.1) bot.yaw=Math.atan2(-dx,-dz);
    if(this.screen!=='playing') return;
    len=Math.hypot(dx,dz);
    if(len>1) {dx/=len;dz/=len;} else {dx=0;dz=0;}
    if(bot.detourIn>0) {dx=bot.detourX;dz=bot.detourZ;}
    const wasGrounded=bot.vy<=0&&bot.y<=this.collision.floorAt(bot.x,bot.z,bot.y+.05)+.05;
    const next=this.collision.move(bot,dx*speed*dt,dz*speed*dt,.36,1.75);
    const actual=Math.hypot(next.x-bot.x,next.z-bot.z);
    bot.speed=actual/Math.max(dt,.001);
    if(actual<speed*dt*.25&&len>1) {
      bot.stuck+=dt;
      if(bot.stuck>.25) {
        const base=Math.atan2(dx,dz),turn=(bot.id%2?1:-1)*(Math.PI*.4+this.rng()*.4);
        bot.detourX=Math.sin(base+turn);bot.detourZ=Math.cos(base+turn);bot.detourIn=.7+this.rng();bot.stuck=0;
      }
    } else bot.stuck=0;
    bot.x=next.x;bot.z=next.z;
    const botFloor=this.collision.floorAt(bot.x,bot.z,bot.y+.65);
    if(wasGrounded&&botFloor>bot.y&&botFloor-bot.y<=.65)bot.y=botFloor;
    bot.vy-=18*dt;const vertical=this.collision.vertical(bot,bot.vy,dt);bot.y=vertical.y;bot.vy=vertical.vy;
    if(vertical.impactSpeed>11)this.hurt(bot,(vertical.impactSpeed-10)*5,null);
    if(bot.lootTarget?.active&&dist(bot,bot.lootTarget)<2.4&&this.collision.visible(eye(bot),{x:bot.lootTarget.x,y:bot.lootTarget.y+.3,z:bot.lootTarget.z})) {
      this.pickup(bot,bot.lootTarget);bot.lootTarget=null;bot.thinkIn=0;
    }
    bot.pickupIn=(bot.pickupIn||0)-dt;
    if(bot.pickupIn<=0) {
      const nearby=this.nearestLoot(bot,2);
      if(nearby&&nearby.item.kind!=='weapon') this.pickup(bot,nearby);
      bot.pickupIn=1;
      if(bot.health<45&&bot.inventory.medkits>0&&!bot.target) {
        bot.inventory={...bot.inventory,medkits:bot.inventory.medkits-1};bot.health=Math.min(100,bot.health+50);
      }
    }
  }

  drive(dt,held,move={x:0,y:0}) {
    const v=this.vehicle,p=this.player;
    const throttle=move.y;
    const brake=held.has('jump');
    const cap=held.has('sprint')?29:23;
    if(brake) v.speed=damp(v.speed,0,7,dt);
    else if(throttle) v.speed=clamp(v.speed+throttle*10*dt,-8,cap);
    else v.speed=damp(v.speed,0,.55,dt);
    const steer=-move.x;
    v.yaw+=steer*dt*1.3*clamp(v.speed/6,-1,1);
    const dx=-Math.sin(v.yaw)*v.speed*dt,dz=-Math.cos(v.yaw)*v.speed*dt;
    const next=this.collision.move({x:v.x,y:v.y+.15,z:v.z},dx,dz,1.25,2.1);
    const wanted=Math.hypot(dx,dz),actual=Math.hypot(next.x-v.x,next.z-v.z);
    if(wanted>.01&&actual<wanted*.4) {
      if(Math.abs(v.speed)>12) {this.hurt(p,(Math.abs(v.speed)-10)*1.5,null);this.hud.toast('发生碰撞，车辆受阻','warning');}
      v.speed*=.25;
    }
    v.x=next.x;v.z=next.z;v.y=this.collision.floorAt(v.x,v.z,v.y+.65,1.25);
    if(v.y<.2) {v.speed=damp(v.speed,0,5,dt);if(this.actionErrorCooldown===0){this.hud.toast(this.touchMode?'水域无法行驶，请点『互动』下车':'水域无法行驶，请按 F 下车','warning');this.actionErrorCooldown=3;}}
    v.root.position.set(v.x,v.y,v.z);v.root.rotation.y=v.yaw;
    v.root.traverse(child=>{if(child.name==='wheel')child.rotation.x-=v.speed*dt/0.45;});
    p.x=v.x;p.z=v.z;p.y=v.y+.65;p.speed=Math.abs(v.speed);
  }
  exitVehicle() {
    const p=this.player,v=this.vehicle;
    for(const offset of [Math.PI/2,-Math.PI/2,Math.PI,0]) {
      const x=v.x+Math.sin(v.yaw+offset)*3,z=v.z+Math.cos(v.yaw+offset)*3,y=this.world.heightAt(x,z);
      if(this.collision.blocked(x,y+.04,z)) continue;
      p.x=x;p.y=y;p.z=z;p.vy=0;this.vehicle=null;v.speed=0;
      document.body.classList.remove('in-vehicle');this.hud.toast('已离开载具');return;
    }
    this.hud.toast('两侧空间不足，先将车移到空旷处','warning');
  }

  throwGrenade() {
    const p=this.player;
    if(this.vehicle||this.action||p.phase!=='ground') return;
    if(!p.inventory.grenades) {this.hud.toast('背包内没有手榴弹','warning');return;}
    p.inventory={...p.inventory,grenades:p.inventory.grenades-1};
    const direction=dirFor(p.yaw,p.pitch),origin=eye(p);
    const mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(.12,1),new THREE.MeshStandardMaterial({color:0x51613c,roughness:.8}));
    mesh.position.set(origin.x,origin.y,origin.z).addScaledVector(direction,.7);this.dynamic.add(mesh);
    this.grenades.push({mesh,velocity:direction.multiplyScalar(17).add(new THREE.Vector3(0,5,0)),fuse:2.8,owner:p});
    this.hud.toast('手榴弹已投出');
  }
  updateGrenades(dt) {
    for(let i=this.grenades.length-1;i>=0;i--) {
      const grenade=this.grenades[i];grenade.fuse-=dt;grenade.velocity.y-=13*dt;
      const position=grenade.mesh.position,travel=grenade.velocity.length()*dt;
      const direction=grenade.velocity.clone().normalize();
      if(travel>0&&this.collision.ray(position,direction,travel)<travel) {grenade.velocity.x*=-.45;grenade.velocity.z*=-.45;grenade.velocity.y=Math.abs(grenade.velocity.y)*.45;}
      else position.addScaledVector(grenade.velocity,dt);
      const floor=this.world.heightAt(position.x,position.z)+.13;
      if(position.y<floor) {position.y=floor;grenade.velocity.y=Math.abs(grenade.velocity.y)*.4;grenade.velocity.x*=.7;grenade.velocity.z*=.7;}
      grenade.mesh.rotation.x+=dt*6;
      if(grenade.fuse>0) continue;
      this.burst(position,0xffa94b,25,7);
      this.audio.shot('akm',.9);
      for(const actor of this.actors) {
        if(!actor.alive) continue;
        const d=new THREE.Vector3(actor.x,actor.y+1,actor.z).distanceTo(position);
        if(d<13&&this.collision.visible({x:position.x,y:position.y+.35,z:position.z},eye(actor))) this.hurt(actor,140*(1-d/13),grenade.owner);
      }
      this.disposeObject(grenade.mesh);this.grenades.splice(i,1);
    }
  }
  tracer(start,end,color) {
    const geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(start.x,start.y-.05,start.z),end]);
    const line=new THREE.Line(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.75}));
    this.dynamic.add(line);this.tracers.push({line,remaining:.075});
  }
  burst(position,color,count,force) {
    for(let i=0;i<count;i++) {
      const mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(force>3?.16:.045,0),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.9}));
      mesh.position.copy(position);this.dynamic.add(mesh);
      this.particles.push({mesh,remaining:force>3?1.1:.35,total:force>3?1.1:.35,velocity:new THREE.Vector3((this.rng()-.5)*force, this.rng()*force, (this.rng()-.5)*force)});
    }
  }

  createZoneVisual() {
    const geometry=new THREE.CylinderGeometry(1,1,180,144,1,true);
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,uniforms:{uTime:{value:0}},
      vertexShader:'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:'varying vec2 vUv; uniform float uTime; void main(){float bands=pow(max(0.0,sin(vUv.x*630.0+uTime*.6)),28.0);float wave=pow(max(0.0,sin(vUv.y*45.0-uTime*1.7)),12.0);float alpha=(.10+bands*.18+wave*.08)*(1.0-vUv.y*.7);gl_FragColor=vec4(.16,.55,1.0,alpha);}'
    });
    this.zoneWall=new THREE.Mesh(geometry,material);this.scene.add(this.zoneWall);this.zoneWall.visible=false;
    this.nextCircle=new THREE.LineLoop(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xf7edba,transparent:true,opacity:.5}));
    this.scene.add(this.nextCircle);this.nextCircle.visible=false;
  }
  updateZoneVisual() {
    const zone=this.zoneInfo;if(!zone)return;
    this.zoneWall.position.set(zone.x,70,zone.z);this.zoneWall.scale.set(Math.max(.01,zone.radius),1,Math.max(.01,zone.radius));
    const points=[];
    for(let i=0;i<144;i++) {
      const angle=i/144*Math.PI*2,x=zone.nextX+Math.sin(angle)*zone.nextRadius,z=zone.nextZ+Math.cos(angle)*zone.nextRadius;
      points.push(new THREE.Vector3(x,Math.max(.1,this.world.heightAt(x,z))+.25,z));
    }
    this.nextCircle.geometry.dispose();this.nextCircle.geometry=new THREE.BufferGeometry().setFromPoints(points);
  }

  updateVisuals(dt) {
    const menu=this.screen==='menu'||this.screen==='loading';
    const p=this.player;
    if(menu) {
      this.menuTime+=dt;
      const a=this.heroAnchor,angle=.45+Math.sin(this.menuTime*.08)*.12;
      this.menuHero.update({dt,speed:0,yaw:Math.PI+.35,weapon:'m416'});
      this.camera.position.set(a.x+Math.sin(angle)*5.1,a.y+1.9,a.z+Math.cos(angle)*5.1);
      this.camera.lookAt(a.x-1.1,a.y+1.0,a.z);
      this.camera.fov=48;this.camera.updateProjectionMatrix();
      this.sun.position.set(a.x-110,a.y+190,a.z+110);this.sun.target.position.set(a.x,a.y,a.z);
    } else if(p) {
      const active=this.screen==='playing',animDt=active?dt:0;
      for(const actor of this.actors) {
        const visible=(actor.isPlayer?(this.thirdPerson||actor.phase!=='ground')&&!this.vehicle:dist(actor,p)<ACTOR_DRAW_DISTANCE&&this.time>=actor.release)&&(!actor.deadTime||this.time-actor.deadTime<12);
        actor.model.root.visible=visible;
        if(!visible)continue;
        actor.model.root.position.set(actor.x,actor.y,actor.z);
        actor.model.update({dt:animDt,speed:actor.speed,yaw:actor.yaw,pitch:actor.pitch,crouch:actor.crouch,prone:actor.prone,airborne:actor.phase==='parachute',parachute:actor.chute,dead:!actor.alive,weapon:actor.inventory.slots[actor.inventory.active]?.id||null});
      }
      this.updateCamera(dt);
      this.viewmodel.root.visible=p.phase==='ground'&&!this.vehicle&&!this.thirdPerson&&p.alive&&!(this.aim&&this.weapon()?.id==='kar98');
      this.viewmodel.update({dt:animDt,speed:p.speed,aim:this.aim,reload:this.action?.type==='reload'?1-this.action.remaining/this.action.total:0,recoil:this.recoil});
      this.sun.position.set(p.x-110,p.y+190,p.z+110);this.sun.target.position.set(p.x,p.y,p.z);
      for(const loot of this.loot) {
        loot.mesh.visible=loot.active&&dist(loot,p)<95;
        if(loot.mesh.visible) {loot.mesh.position.y=loot.y+Math.sin(this.elapsed*2+loot.phase)*.07;loot.mesh.rotation.y=this.elapsed*.3+loot.phase;}
      }
      this.zoneWall.material.uniforms.uTime.value=this.elapsed;
    }
    if(this.screen==='paused')return;
    for(let i=this.tracers.length-1;i>=0;i--) {
      const tracer=this.tracers[i];tracer.remaining-=dt;
      if(tracer.remaining<=0){this.disposeObject(tracer.line);this.tracers.splice(i,1);}
    }
    for(let i=this.particles.length-1;i>=0;i--) {
      const particle=this.particles[i];particle.remaining-=dt;
      if(particle.remaining<=0){this.disposeObject(particle.mesh);this.particles.splice(i,1);continue;}
      particle.velocity.y-=9*dt;particle.mesh.position.addScaledVector(particle.velocity,dt);particle.mesh.material.opacity=particle.remaining/particle.total;
    }
  }
  updateCamera(dt) {
    const p=this.player,position=eye(p);
    const third=this.thirdPerson||p.phase!=='ground'||this.vehicle;
    let fov=this.aim?(this.weapon()?.id==='kar98'?25:46):72;
    if(p.phase==='plane') {
      this.camera.position.set(p.x+36,p.y+12,p.z+48);
      this.camera.lookAt(p.x,p.y-10,p.z-40);fov=62;
      p.model.root.visible=false;
    } else if(third) {
      const distance=this.vehicle?8:p.phase==='parachute'?9:3.3;
      const pitch=p.phase==='parachute'?Math.max(-.65,p.pitch):clamp(p.pitch,-.7,.8);
      const direction=dirFor(p.yaw,pitch);
      // 焦点压到胸口高度：越肩视角要让角色完整入画（含腿脚），对准头部会把身体挤出画面底部。
      // 再往下 (-.5) 则脚会落进底部道具键区域，-.42 是让整个人刚好落在 HUD 上方的折中值。
      const focus=new THREE.Vector3(position.x,position.y+(this.vehicle?1:-.42),position.z);
      const backwards=direction.clone().negate();
      const clear=this.collision.ray(focus,backwards,distance);
      const cameraDistance=Math.max(.35,Math.min(distance,clear-.2));
      this.camera.position.copy(focus).addScaledVector(direction,-cameraDistance);
      // 右肩偏移：镜头偏向右侧，角色让到画面左侧，露出前方视野（与和平精英手感一致）。
      // 注意 cross() 会原地修改向量，必须 clone()，否则会污染上面的 direction。
      if(!this.vehicle&&p.phase==='ground') {
        const right=direction.clone().cross(new THREE.Vector3(0,1,0)).normalize();
        this.camera.position.addScaledVector(right,-.62);
      }
      this.camera.position.y=Math.max(this.camera.position.y,this.world.heightAt(this.camera.position.x,this.camera.position.z)+.4);
      this.camera.lookAt(focus.addScaledVector(direction,10));
    } else {
      const bob=Math.sin(this.time*(p.speed>6?14:10))*Math.min(p.speed/5,1)*.035;
      this.camera.position.set(position.x,position.y+bob,position.z);
      const offset=this.lean||0;
      this.camera.position.x+=Math.cos(p.yaw)*offset;this.camera.position.z-=Math.sin(p.yaw)*offset;
      this.camera.rotation.set(p.pitch+this.recoil*.25,p.yaw,-offset*.16,'YXZ');
    }
    this.camera.fov=damp(this.camera.fov,fov,13,dt);this.camera.updateProjectionMatrix();
    document.body.classList.toggle('aiming',!!this.aim);
    document.body.classList.toggle('scoped',!!this.aim&&this.weapon()?.id==='kar98'&&!this.thirdPerson);
  }

  updateHud() {
    const p=this.player;if(!p)return;
    const slot=p.inventory.slots[p.inventory.active],weapon=this.weapon();
    let prompt='';
    const tap=this.touchMode?'『互动』':'F';
    if(p.phase==='plane') prompt=this.touchMode?'点击「跳伞」选择你的降落地点':'F / 空格  跳伞 · 选择你的降落地点';
    else if(p.phase==='parachute') prompt=p.chute?(this.touchMode?'摇杆调整方向 · 靠近建筑搜集装备':'WASD 调整方向 · 靠近建筑搜集装备'):(this.touchMode?'点击「开伞」提前展开降落伞':'F / 空格 开伞 · WASD 调整落点');
    else if(this.vehicle) prompt=this.touchMode?'『互动』下车 · 摇杆控制油门与转向':'F 下车 · 空格 刹车 · Shift 加速';
    else {
      const loot=this.nearestLoot(p);
      if(loot) prompt=`${tap} 拾取 ${lootLabel(loot.item)}`;
      else if(this.vehicles.some(v=>dist(v,p)<4.5))prompt=`${tap} 驾驶越野车`;
      else if(!weapon)prompt=this.touchMode?'寻找地面装备 · 靠近后按「互动」拾取':'寻找地面装备 · F 拾取 · M 查看地图';
    }
    const markers=[{x:p.x,z:p.z,type:'player',heading:(-p.yaw*180/Math.PI+360)%360},...this.vehicles.map(v=>({x:v.x,z:v.z,type:'vehicle'}))];
    this.hud.update({phase:p.phase,alive:this.actors.filter(a=>a.alive).length,kills:this.kills,health:p.health,armor:p.inventory.armor,helmet:p.inventory.helmet,
      boost:this.boost,speed:p.speed*3.6,heading:(-p.yaw*180/Math.PI+360)%360,weapon:weapon?.name||'徒手',weaponId:weapon?.id||null,rounds:slot?.rounds||0,reserve:weapon?p.inventory.ammo[weapon.ammo]:0,
      slot:p.inventory.active,slots:p.inventory.slots,medkits:p.inventory.medkits,boosts:p.inventory.boosts,grenades:p.inventory.grenades,
      zone:this.zoneInfo,position:{x:p.x,z:p.z},locations:this.world.locations,markers,prompt,
      action:this.action?{label:this.action.label,progress:1-this.action.remaining/this.action.total}:null,
      airTime:p.phase==='plane'?Math.max(0,24-this.planeTime):Math.max(0,p.y-this.world.heightAt(p.x,p.z)),vehicle:!!this.vehicle,fps:Math.round(this.fps),time:this.time,
      chute:!!p.chute,touch:this.touchMode,
      // 空中阶段收起战斗键，把屏幕让给跳伞/开伞按钮。
      airborne:p.phase==='plane'||p.phase==='parachute',
      fireMode:weapon?(weapon.automatic&&this.fireModeAuto?'自动':'单发'):'近战',aim:this.aim});
  }
  finish(win) {
    if(this.screen!=='playing')return;
    this.updateHud();this.screen='result';this.input.setActive(false);this.action=null;
    this.overlay(false,false,false);this.audio.update({speed:0,vehicle:false,airborne:false});this.audio.end(win);
    const rank=win?1:this.actors.filter(a=>a.alive).length+1;
    this.hud.showResult({win,rank,kills:this.kills,time:this.time,damage:Math.round(this.damageDone),name:this.options.name});
    this.hud.setScreen('result');document.body.classList.remove('aiming','scoped','outside-zone','airborne');
  }
}
