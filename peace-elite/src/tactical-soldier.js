import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createTacticalCharacter} from '../character-preview/tactical-character.js';
import {createSoldierEquipment} from './models.js';

let shared = null, pending = null, live = 0;
const WEAPONS = ['m416','akm','ump45','kar98'];
const clamp = THREE.MathUtils.clamp;
function floats(value) {
  if (typeof value !== 'string') return Float32Array.from(value);
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function decodeClips(data) {
  const types = {quaternion:THREE.QuaternionKeyframeTrack,vector:THREE.VectorKeyframeTrack,number:THREE.NumberKeyframeTrack};
  return data.map(c => new THREE.AnimationClip(c.name,c.duration,c.tracks.map(t => {
    const Type=types[t.type]; if (!Type) throw new Error('Unknown baked track type');
    return new Type(t.name,floats(t.times),floats(t.values));
  })));
}
// Batch only rigid equipment with the same bone AND original material. The
// authored body/eyes/brows and all skin attributes are deliberately untouched.
function batchEquipment(root) {
  root.updateMatrixWorld(true);
  const batches = new Map(), originals = new Set();
  root.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh || o.name !== 'tactical-equipment') return;
    const key = o.parent.uuid + ':' + o.material.uuid;
    if (!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(o);
  });
  for (const pieces of batches.values()) {
    const parent=pieces[0].parent, inverse=parent.matrixWorld.clone().invert();
    const transformed=pieces.map(piece => {
      originals.add(piece.geometry);
      const g=piece.geometry.index ? piece.geometry.toNonIndexed() : piece.geometry.clone();
      for (const key of Object.keys(g.attributes)) if (!['position','normal'].includes(key)) g.deleteAttribute(key);
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse,piece.matrixWorld));
      return g;
    });
    const geometry=mergeGeometries(transformed,false); transformed.forEach(g=>g.dispose());
    if (!geometry) throw new Error('Cannot batch character equipment');
    const mesh=new THREE.Mesh(geometry,pieces[0].material); mesh.name='tactical-equipment-batch';
    mesh.castShadow=mesh.receiveShadow=true; parent.add(mesh); pieces.forEach(p=>p.removeFromParent());
  }
  originals.forEach(g=>g.dispose());
}

// Same skin rebind as SkeletonUtils, but explicit Mesh constructor arguments
// avoid allocating throwaway default geometry/material for every cloned mesh.
function cloneSkeleton(source) {
  const lookup=new Map();
  function copy(node) {
    const target=node.isSkinnedMesh ? new THREE.SkinnedMesh(node.geometry,node.material)
      :node.isMesh ? new THREE.Mesh(node.geometry,node.material)
      :node.isBone ? new THREE.Bone() :node.isGroup ? new THREE.Group() :new THREE.Object3D();
    target.copy(node,false);lookup.set(node,target);
    for(const child of node.children)target.add(copy(child));
    return target;
  }
  const root=copy(source);
  for(const [original,target]of lookup)if(original.isSkinnedMesh){
    const bones=original.skeleton.bones.map(bone=>lookup.get(bone));
    if(bones.some(bone=>!bone))throw new Error('Character bone outside template hierarchy');
    target.skeleton=new THREE.Skeleton(bones,original.skeleton.boneInverses);
    target.bindMatrix.copy(original.bindMatrix);target.bind(target.skeleton,target.bindMatrix);
  }
  return root;
}

function weaponProfile(root) {
  root.updateMatrixWorld(true);
  const inverse=root.matrixWorld.clone().invert(),matrix=new THREE.Matrix4(),point=new THREE.Vector3(),unique=new Map();
  root.traverse(mesh=>{
    if(!mesh.isMesh)return;
    matrix.multiplyMatrices(inverse,mesh.matrixWorld);
    const positions=mesh.geometry.attributes.position;
    for(let i=0;i<positions.count;i++){
      point.fromBufferAttribute(positions,i).applyMatrix4(matrix);
      unique.set(point.y+','+point.z,[point.y,point.z]);
    }
  });
  return Float32Array.from(Array.from(unique.values()).flat());
}
function weaponBottom(profile,pitch) {
  const sin=Math.sin(pitch),cos=Math.cos(pitch);let lowest=Infinity;
  for(let i=0;i<profile.length;i+=2)lowest=Math.min(lowest,profile[i]*cos-profile[i+1]*sin);
  return lowest;
}

/** Parse once per page; clones share immutable appearance/clips, never bones. */
export async function prepareTacticalSoldiers(payload) {
  if (shared) return shared;
  if (pending) return pending;
  if (!payload?.model || !payload?.clips) throw new Error('Missing embedded tactical character assets; build the game first');
  pending=(async()=>{
    const clips=decodeClips(payload.clips);
    const prototype=await createTacticalCharacter(payload.model,clips);
    let equipment;
    try {
      batchEquipment(prototype.root);
      equipment=createSoldierEquipment(); prototype.root.add(equipment.root);
      prototype.root.updateMatrixWorld(true);
      const weaponProfiles=new Map(WEAPONS.map(id=>[id,weaponProfile(equipment.root.getObjectByName(id))]));
      prototype.root.traverse(mesh=>{if(mesh.isMesh&&!mesh.isSkinnedMesh&&!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();});
      shared={prototype,equipment,clips,weaponProfiles,source:payload.source}; return shared;
    } catch(error) {equipment?.root.removeFromParent();equipment?.dispose();prototype.dispose();throw error;}
  })();
  try {return await pending;} finally {pending=null;}
}

/** Only page/test teardown may free the template, never individual actor resets. */
export function disposeTacticalSoldiers() {
  if (pending || live) throw new Error('Cannot dispose tactical cache while loading or actors are live');
  if (!shared) return;
  shared.equipment.root.removeFromParent(); shared.equipment.dispose(); shared.prototype.dispose(); shared=null;
}

/** Same gameplay interface as the old actor; physics origin/yaw remain unchanged. */
export function createTacticalSoldier({color=0x647466,player=false}={}) {
  if (!shared) throw new Error('Tactical soldier assets are not prepared');
  const cache=shared, root=new THREE.Group(); root.name='soldier';
  root.userData.characterRoute='continuous-skinned'; root.userData.player=Boolean(player); root.userData.color=color;
  const correction=new THREE.Group();correction.name='tactical-floor-correction';root.add(correction);
  const ground=new THREE.Group(); ground.name='tactical-ground'; ground.rotation.y=Math.PI; correction.add(ground);
  const content=cloneSkeleton(cache.prototype.root); ground.add(content);
  const body=content.getObjectByName('SuperHero_Male'), bones=new Map(), skeletons=new Set();
  content.traverse(o=>{if(o.isBone)bones.set(o.name,o);if(o.skeleton)skeletons.add(o.skeleton);});
  const mount=content.getObjectByName('weapon-mount'), canopy=content.getObjectByName('parachute');
  const guns=Object.fromEntries(WEAPONS.map(id=>[id,mount.getObjectByName(id)]));
  const mixer=new THREE.AnimationMixer(root);
  const actions=new Map(cache.clips.map(c=>[c.name,mixer.clipAction(c)]));
  for (const [name,action] of actions) {action.setLoop(name==='Death01'?THREE.LoopOnce:THREE.LoopRepeat,name==='Death01'?1:Infinity);action.clampWhenFinished=name==='Death01';}
  const arms=['l','r'].map((side,index)=>({side:index===0?-1:1,upper:bones.get('upperarm_'+side),lower:bones.get('lowerarm_'+side),hand:bones.get('hand_'+side)}));
  // Persistent IK scratch; joint translations/scales are NEVER stretched.
  const A=new THREE.Vector3(),B=new THREE.Vector3(),C=new THREE.Vector3(),T=new THREE.Vector3(),E=new THREE.Vector3();
  const direction=new THREE.Vector3(),bend=new THREE.Vector3(),from=new THREE.Vector3(),to=new THREE.Vector3();
  const worldQ=new THREE.Quaternion(),parentQ=new THREE.Quaternion(),deltaQ=new THREE.Quaternion(),actorQ=new THREE.Quaternion();
  const inverseRoot=new THREE.Matrix4(),point=new THREE.Vector3(),axisX=new THREE.Vector3(1,0,0);
  const head=bones.get('Head'), headLocal=new THREE.Vector3();
  const baseRotations=new Map();
  let current=null,disposed=false,accumulated=0,phase=0,groundBlendUntil=0;
  let sampledTime=-1,sampledPitch=NaN,sampledWeapon,sampledAction,sampledOpen,floorShift=0;
  const posture=name=>name.startsWith('Prone_')?'prone':name.startsWith('Crouch_')?'crouch':name==='Death01'?'dead':name==='Jump_Loop'?'air':'stand';
  function select(name) {
    const next=actions.get(name); if (!next) throw new Error('Missing game posture: '+name);
    if (next===current) return;
    if(current&&posture(name)!==posture(current.getClip().name))groundBlendUntil=mixer.time+.20;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if(current){current.fadeOut(.16);next.fadeIn(.16);} current=next;
  }
  function rotateBone(bone,desired) {
    bone.parent.getWorldQuaternion(parentQ); bone.quaternion.copy(parentQ.invert().multiply(desired)).normalize(); bone.updateMatrixWorld(true);
  }
  function solve(arm,target) {
    arm.upper.getWorldPosition(A);arm.lower.getWorldPosition(B);arm.hand.getWorldPosition(C);
    const l1=A.distanceTo(B),l2=B.distanceTo(C);
    direction.copy(target).sub(A);const distance=clamp(direction.length(),Math.abs(l1-l2)+.002,l1+l2-.002);direction.normalize();
    T.copy(A).addScaledVector(direction,distance);
    bend.set(arm.side*.7,-1,.25).applyQuaternion(actorQ);bend.addScaledVector(direction,-bend.dot(direction)).normalize();
    const along=(l1*l1+distance*distance-l2*l2)/(2*distance);
    E.copy(A).addScaledVector(direction,along).addScaledVector(bend,Math.sqrt(Math.max(0,l1*l1-along*along)));
    from.copy(B).sub(A).normalize();to.copy(E).sub(A).normalize();deltaQ.setFromUnitVectors(from,to);
    arm.upper.getWorldQuaternion(worldQ);worldQ.premultiply(deltaQ);rotateBone(arm.upper,worldQ);
    arm.lower.getWorldPosition(B);arm.hand.getWorldPosition(C);
    from.copy(C).sub(B).normalize();to.copy(T).sub(B).normalize();deltaQ.setFromUnitVectors(from,to);
    arm.lower.getWorldQuaternion(worldQ);worldQ.premultiply(deltaQ);rotateBone(arm.lower,worldQ);
  }
  function gunPitch(profile,pitch,height) {
    if(!profile||height+weaponBottom(profile,pitch)>=.008)return pitch;
    let safe=0,blocked=pitch;
    for(let i=0;i<18;i++){
      const candidate=(safe+blocked)/2;
      if(height+weaponBottom(profile,candidate)>=.008)safe=candidate;else blocked=candidate;
    }
    return safe;
  }
  function correctTransitionFloor() {
    let lowest=Infinity;
    root.getWorldPosition(point);const floorY=point.y;
    root.traverseVisible(mesh=>{
      if(!mesh.isMesh)return;
      if(mesh.isSkinnedMesh){
        const count=mesh.geometry.attributes.position.count;
        for(let i=0;i<count;i++){mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld);lowest=Math.min(lowest,point.y);}
      }else{
        const box=mesh.geometry.boundingBox,m=mesh.matrixWorld.elements;
        const x=(box.min.x+box.max.x)/2,y=(box.min.y+box.max.y)/2,z=(box.min.z+box.max.z)/2;
        const bottom=m[1]*x+m[5]*y+m[9]*z+m[13]-Math.abs(m[1])*(box.max.x-box.min.x)/2-Math.abs(m[5])*(box.max.y-box.min.y)/2-Math.abs(m[9])*(box.max.z-box.min.z)/2;
        lowest=Math.min(lowest,bottom);
      }
    });
    return Math.max(0,floorY+.006-lowest);
  }
  function update({dt,speed=0,yaw=0,pitch=0,crouch=false,prone=false,airborne=false,parachute=false,dead=false,weapon='m416',distance=0}) {
    if(disposed) throw new Error('Soldier has been disposed');
    for(const[name,value]of Object.entries({dt,speed,yaw,pitch,distance}))if(!Number.isFinite(value))throw new TypeError(name+' must be finite');
    if(dt<0)throw new RangeError('dt must be nonnegative');
    if(weapon!==null&&!WEAPONS.includes(weapon))throw new RangeError('Unknown weapon: '+weapon);
    root.rotation.y=yaw;correction.position.y=0;
    const opened=Boolean(parachute&&!dead),moving=Math.abs(speed)>.15;
    const name=dead?'Death01':airborne?'Jump_Loop':prone?(moving?'Prone_Move':'Prone_Idle'):crouch?(moving?'Crouch_Fwd_Loop':'Crouch_Idle_Loop'):Math.abs(speed)>4.8?'Jog_Fwd_Loop':moving?'Walk_Loop':'Idle_Loop';
    select(name);current.setEffectiveTimeScale(dead||!moving?1:clamp(Math.abs(speed)/(prone?1.2:crouch?2.2:name==='Jog_Fwd_Loop'?6:3),.5,1.8));
    accumulated=Math.min(.5,accumulated+dt);
    const cadence=player||distance<55?0:distance<130?1/15:1/8;
    // A rendered distant NPC still receives the current weapon/yaw immediately.
    // Reset all mixer-authored rotations before applying additive IK each frame.
    for (const [bone,q] of baseRotations) bone.quaternion.copy(q);
    if(dt===0){mixer.update(0);}else if(accumulated>=cadence){mixer.update(accumulated);accumulated=0;}else{mixer.update(0);}
    for (const bone of bones.values()) {if(!baseRotations.has(bone))baseRotations.set(bone,bone.quaternion.clone());else baseRotations.get(bone).copy(bone.quaternion);}
    phase=(phase+dt*2)% (Math.PI*2);
    root.updateMatrixWorld(true);inverseRoot.copy(root.matrixWorld).invert();root.getWorldQuaternion(actorQ);
    head.getWorldPosition(headLocal).applyMatrix4(inverseRoot);
    const profile=cache.weaponProfiles.get(weapon);
    let mountY=dead?.32:Math.max(prone?.23:.4,headLocal.y-(prone?-.04:.22));
    if(profile)mountY=Math.max(mountY,.008-weaponBottom(profile,0));
    point.set(.10,mountY,prone?-.30:-.12).applyMatrix4(root.matrixWorld);
    mount.position.copy(mount.parent.worldToLocal(point));
    const visualPitch=dead?0:gunPitch(profile,clamp(pitch,-1.1,1.1),mountY);
    worldQ.copy(actorQ).multiply(deltaQ.setFromAxisAngle(axisX,visualPitch));
    mount.parent.getWorldQuaternion(parentQ);mount.quaternion.copy(parentQ.invert().multiply(worldQ));mount.updateMatrixWorld(true);
    for(const id of WEAPONS)guns[id].visible=id===weapon&&!parachute;
    canopy.visible=opened;canopy.rotation.set(Math.sin(phase*.3)*.016,Math.PI,Math.sin(phase*.45)*.025);
    if(opened){
      for(const arm of arms){point.set(arm.side*.24,headLocal.y+.27,.07).applyMatrix4(root.matrixWorld);solve(arm,point);}
    }else if(weapon!==null&&!dead){
      for(const arm of arms){point.set(0,arm.side>0?-.102:-.045,arm.side>0?.02:-.275).applyMatrix4(mount.matrixWorld);solve(arm,point);}
    }
    // Small head tracking in actor-world axes, independent of UE local axes.
    if(!dead&&!opened){head.getWorldQuaternion(worldQ);deltaQ.setFromAxisAngle(axisX,clamp(pitch,-.7,.7)*.4);deltaQ.premultiply(actorQ).multiply(parentQ.copy(actorQ).invert());worldQ.premultiply(deltaQ);rotateBone(head,worldQ);}
    root.updateMatrixWorld(true);
    if(mixer.time<groundBlendUntil){
      if(sampledTime!==mixer.time||sampledPitch!==pitch||sampledWeapon!==weapon||sampledAction!==current||sampledOpen!==opened){
        floorShift=correctTransitionFloor();sampledTime=mixer.time;sampledPitch=pitch;sampledWeapon=weapon;sampledAction=current;sampledOpen=opened;
      }
      correction.position.y=floorShift;root.updateMatrixWorld(true);
    }
  }
  function dispose(){if(disposed)return;disposed=true;mixer.stopAllAction();mixer.uncacheRoot(root);root.removeFromParent();for(const skeleton of skeletons)skeleton.dispose();live--;}
  live++;root.userData.dispose=dispose;
  // Seed a natural idle, not a T pose, without waiting for the first game frame.
  select('Idle_Loop');mixer.update(1);update({dt:0});
  return {root,body,bones,update,dispose};
}
