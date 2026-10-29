import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const loader = new GLTFLoader();
const parse = data => new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
const clamp = THREE.MathUtils.clamp;

// This prototype uses an authored, weighted humanoid surface. Primitive geometry
// is confined to separate hard equipment; it does not construct the human body.
export async function createTacticalCharacter(modelJson, animationBuffer, options = {}) {
  const baked = Array.isArray(animationBuffer);
  const [asset, library] = await Promise.all([parse(JSON.stringify(modelJson)), baked ? null : parse(animationBuffer)]);
  const root = new THREE.Group(); root.name = 'skinned-tactical-prototype';
  const human = asset.scene; root.add(human);
  human.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(human);
  const size = box.getSize(new THREE.Vector3());
  const scale = 1.72 / size.y;
  human.scale.multiplyScalar(scale);
  human.position.set(-(box.min.x + box.max.x) * .5 * scale, -box.min.y * scale, -(box.min.z + box.max.z) * .5 * scale);
  root.updateMatrixWorld(true);
  const bones = new Map();
  human.traverse(o => { if (o.isBone) bones.set(o.name, o); });
  const body = human.getObjectByName('SuperHero_Male');
  if (!body?.isSkinnedMesh) throw new Error('Expected the licensed skinned humanoid body');
  const geometry = body.geometry;
  const positions = geometry.attributes.position;
  const joints = geometry.attributes.skinIndex;
  const weights = geometry.attributes.skinWeight;
  const normals = geometry.attributes.normal;
  const rest = new Float32Array(positions.count * 3);
  const garment = new Float32Array(positions.count);
  const world = new THREE.Vector3(), normal = new THREE.Vector3();
  const inv = body.matrixWorld.clone().invert();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(body.matrixWorld);
  for (let i = 0; i < positions.count; i++) {
    world.fromBufferAttribute(positions, i).applyMatrix4(body.matrixWorld);
    let exposed = 0;
    for (let j = 0; j < 4; j++) {
      const bone = body.skeleton.bones[joints.getComponent(i, j)];
      const name = bone?.name || '';
      // Keep an actual face, neck and articulated fingers, not a texture mask.
      if (/Head|neck|index|middle|pinky|ring|thumb/.test(name)) exposed += weights.getComponent(i, j);
    }
    const cloth = 1 - clamp(exposed * 1.5, 0, 1);
    garment[i] = cloth;
    rest.set(world.toArray(), i * 3);
    if (cloth > .01) {
      normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      // A modest fabric allowance above the authored body; the weighted topology
      // and bind pose remain intact, including shoulder and elbow transitions.
      const allowance = world.y < .23 ? .010 : .007;
      world.addScaledVector(normal, allowance * cloth);
      world.y = Math.max(.004, world.y);
      world.applyMatrix4(inv);
      positions.setXYZ(i, world.x, world.y, world.z);
    }
  }
  positions.needsUpdate = true;
  geometry.setAttribute('previewRest', new THREE.BufferAttribute(rest, 3));
  geometry.setAttribute('previewGarment', new THREE.BufferAttribute(garment, 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const eyebrowMaterial=human.getObjectByName('Eyebrows').material;
  eyebrowMaterial.color.setHex(0x382e24);eyebrowMaterial.roughness=.92;
  body.material.roughness = .78;
  body.material.normalScale.set(.5, .5);
  body.material.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute vec3 previewRest;\nattribute float previewGarment;\nvarying vec3 vPreviewRest;\nvarying float vPreviewGarment;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPreviewRest = previewRest; vPreviewGarment = previewGarment;');
    shader.fragmentShader = 'varying vec3 vPreviewRest;\nvarying float vPreviewGarment;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      vec3 p = vPreviewRest;
      float grain = sin(p.x*920.0)*sin(p.y*1100.0)*sin(p.z*980.0);
      float camo = sin(p.x*58.0 + sin(p.y*21.0)*2.0)*sin(p.y*45.0 + p.z*39.0);
      vec3 textile = mix(vec3(.100,.126,.091), vec3(.165,.184,.137), smoothstep(-.2,.45,camo));
      textile *= .965 + .035 * grain;
      textile = mix(textile, vec3(.067,.080,.065), smoothstep(.94,1.0,p.y));
      if (p.y < .22) textile = vec3(.023,.028,.027)*(1.0+.04*grain);
      diffuseColor.rgb = mix(diffuseColor.rgb, textile, vPreviewGarment);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, .94, vPreviewGarment);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 previewClothNormal = normal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, previewClothNormal, vPreviewGarment));');
  };
  body.material.customProgramCacheKey = () => 'tactical-fabric-v1';
  body.material.needsUpdate = true;
  const gear = [];
  const fabrics = {
    carrier: new THREE.MeshStandardMaterial({color:0x485044, roughness:.95}),
    dark: new THREE.MeshStandardMaterial({color:0x232d29, roughness:.88}),
    webbing: new THREE.MeshStandardMaterial({color:0x80745a, roughness:1}),
    rubber: new THREE.MeshStandardMaterial({color:0x192322, roughness:.82}),
    metal: new THREE.MeshStandardMaterial({color:0x69746c, metalness:.65, roughness:.44}),
  };
  function equipment(geometry, material, position, boneName, rotation=[0,0,0]) {
    const mesh = new THREE.Mesh(geometry, material); mesh.name = 'tactical-equipment';
    mesh.position.set(...position); mesh.rotation.set(...rotation);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh); root.updateMatrixWorld(true);
    const parent = bones.get(boneName);
    if (!parent) throw new Error(`Missing equipment attachment bone: ${boneName}`);
    parent.attach(mesh); gear.push(mesh); return mesh;
  }
  const rounded = (w,h,d,r=.012) => new RoundedBoxGeometry(w,h,d,1,r);
  // Curved carrier and separate webbing/pouches; the sleeves underneath are skinned.
  equipment(rounded(.365,.35,.09,.035), fabrics.carrier, [0,1.205,.137], 'spine_03');
  equipment(rounded(.315,.33,.10,.045), fabrics.dark, [0,1.215,-.139], 'spine_03');
  for (const side of [-1,1]) {
    equipment(rounded(.047,.25,.038,.013), fabrics.webbing, [side*.143,1.371,.102], 'spine_03', [0,0,side*-.12]);
    equipment(rounded(.046,.19,.04,.012), fabrics.webbing, [side*.13,1.36,-.102], 'spine_03');
    equipment(rounded(.025,.031,.049,.004), fabrics.metal, [side*.142,1.347,.127], 'spine_03');
  }
  for (const x of [-.108,0,.108]) {
    equipment(rounded(.087,.135,.046,.011), fabrics.webbing, [x,1.128,.201], 'spine_03');
    equipment(rounded(.080,.025,.051,.007), fabrics.carrier, [x,1.173,.206], 'spine_03');
  }
  for (const y of [1.26,1.292,1.324]) equipment(rounded(.235,.012,.009,.003), fabrics.webbing, [0,y,.188], 'spine_03');
  const belt = equipment(new THREE.TorusGeometry(.161,.018,8,48), fabrics.dark, [0,.934,0], 'pelvis', [Math.PI/2,0,0]);
  belt.scale.y *= .80;
  equipment(rounded(.063,.044,.025,.006), fabrics.metal, [0,.932,.132], 'pelvis');
  equipment(rounded(.070,.105,.065,.014), fabrics.carrier, [.191,.89,0], 'pelvis');
  // Open-face helmet: a smoothly varying rim, not a full sphere over the face.
  const vertices=[], indices=[];
  const rows=12, cols=32;
  for (let row=0; row<=rows; row++) for (let col=0; col<=cols; col++) {
    const phi=col/cols*Math.PI*2;
    const forward=(Math.cos(phi)+1)*.5;
    const theta=row/rows*(1.83-.52*forward);
    vertices.push(Math.sin(theta)*Math.sin(phi)*.126, Math.cos(theta)*.143, Math.sin(theta)*Math.cos(phi)*.136);
  }
  for (let r=0;r<rows;r++) for(let c=0;c<cols;c++) {
    const a=r*(cols+1)+c,b=a+cols+1; indices.push(a,b,a+1,b,b+1,a+1);
  }
  const shell=new THREE.BufferGeometry(); shell.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3)); shell.setIndex(indices); shell.computeVertexNormals();
  equipment(shell,fabrics.carrier,[0,1.599,-.008],'Head');
  for (const side of [-1,1]) {
    equipment(rounded(.022,.030,.103,.009),fabrics.dark,[side*.123,1.622,-.001],'Head');
    equipment(rounded(.022,.070,.057,.012),fabrics.rubber,[side*.113,1.558,-.018],'Head');
  }
  // The Godot animation skeleton uses DEF-* names and different local axes.
  // Retarget in reference-pose WORLD rotation space, then recover target-local
  // rotations in hierarchy order. Preserve authored target bone lengths.
  const clips = baked ? animationBuffer.map(c => c instanceof THREE.AnimationClip ? c : THREE.AnimationClip.parse(c)) : [];
  if (!baked) {
  const sourceBones=new Map(); library.scene.traverse(o=>{if(o.isBone)sourceBones.set(o.name,o);});
  const names={root:'root',pelvis:'DEF-hips',spine_01:'DEF-spine.001',spine_02:'DEF-spine.002',spine_03:'DEF-spine.003',neck_01:'DEF-neck',Head:'DEF-head'};
  for(const side of ['l','r']){
    const S=side.toUpperCase();
    for(const[target,source]of [['clavicle','shoulder'],['upperarm','upper_arm'],['lowerarm','forearm'],['hand','hand'],['thigh','thigh'],['calf','shin'],['foot','foot'],['ball','toe']])names[`${target}_${side}`]=`DEF-${source}.${S}`;
    for(const finger of ['index','middle','pinky','ring','thumb'])for(let part=1;part<=3;part++)names[`${finger}_0${part}_${side}`]=`DEF-${finger==='thumb'?'thumb':'f_'+finger}.0${part}.${S}`;
  }
  const sourceFor=bone=>sourceBones.get(THREE.PropertyBinding.sanitizeNodeName(names[bone.name]||''));
  const ordered=[...bones.values()]; // human.traverse is parent-before-child
  for(const name of ['pelvis','Head','upperarm_l','upperarm_r','calf_l','calf_r'])if(!sourceFor(bones.get(name)))throw new Error(`No source mapping for required bone ${name}`);
  const targetRest=ordered.map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone(),worldQ:b.getWorldQuaternion(new THREE.Quaternion()),worldP:b.getWorldPosition(new THREE.Vector3())}));
  function restoreTarget(){for(const r of targetRest){r.b.position.copy(r.p);r.b.quaternion.copy(r.q);r.b.scale.copy(r.s);}root.updateMatrixWorld(true);}
  const sourceMixer=new THREE.AnimationMixer(library.scene);
  const reference=library.animations.find(c=>c.name==='A_TPose');
  if(!reference)throw new Error('Animation library is missing its reference pose');
  sourceMixer.clipAction(reference).play();sourceMixer.update(0);library.scene.updateMatrixWorld(true);
  const sourceRest=new Map();for(const[name,b]of sourceBones)sourceRest.set(name,{q:b.getWorldQuaternion(new THREE.Quaternion()),p:b.getWorldPosition(new THREE.Vector3())});
  sourceMixer.stopAllAction();
  const sourceHip=sourceFor(bones.get('pelvis'));
  const hipReference=sourceRest.get(sourceHip.name).p;
  const targetHip=targetRest.find(r=>r.b.name==='pelvis');
  const hipScale=targetHip.worldP.y/hipReference.y;
  const clipNames=options.clipNames || ['Idle_Loop','Walk_Loop','Jog_Fwd_Loop','Crouch_Idle_Loop','Crouch_Fwd_Loop','Pistol_Aim_Neutral'];
  const sourceWorld=new THREE.Quaternion(),desired=new THREE.Quaternion(),parentQ=new THREE.Quaternion();
  const hipWorld=new THREE.Vector3();
  for(const clipName of clipNames){
    const clip=library.animations.find(c=>c.name===clipName);if(!clip)continue;
    sourceMixer.stopAllAction();
    const action=sourceMixer.clipAction(clip);action.reset().setLoop(THREE.LoopOnce,1).play();action.clampWhenFinished=true;
    const frames=Math.max(2,Math.ceil(clip.duration*30)+1);
    const times=new Float32Array(frames);
    const data=targetRest.filter(r=>sourceFor(r.b)).map(r=>({rest:r,values:new Float32Array(frames*4)}));
    const hipValues=new Float32Array(frames*3);
    for(let frame=0;frame<frames;frame++){
      const time=clip.duration*frame/(frames-1);times[frame]=time;
      sourceMixer.setTime(Math.min(time,clip.duration-1e-6));library.scene.updateMatrixWorld(true);
      restoreTarget();
      for(const track of data){
        const r=track.rest,src=sourceFor(r.b),ref=sourceRest.get(src.name);
        src.getWorldQuaternion(sourceWorld);
        desired.copy(sourceWorld).multiply(ref.q.clone().invert()).multiply(r.worldQ);
        r.b.parent.getWorldQuaternion(parentQ);
        r.b.quaternion.copy(parentQ.invert().multiply(desired)).normalize();
        if(r.b.name==='pelvis'){
          src.getWorldPosition(hipWorld);hipWorld.sub(hipReference).multiplyScalar(hipScale).add(r.worldP);
          // In-place preview: retain vertical posture, not locomotion drift.
          hipWorld.x=r.worldP.x;hipWorld.z=r.worldP.z;
          r.b.position.copy(r.b.parent.worldToLocal(hipWorld));
          r.b.position.toArray(hipValues,frame*3);
        }
        r.b.updateMatrixWorld(true);
        r.b.quaternion.toArray(track.values,frame*4);
      }
    }
    const tracks=data.map(d=>new THREE.QuaternionKeyframeTrack(`${d.rest.b.name}.quaternion`,times.slice(),d.values));
    tracks.push(new THREE.VectorKeyframeTrack('pelvis.position',times.slice(),hipValues));
    clips.push(new THREE.AnimationClip(clip.name,clip.duration,tracks));
  }
  sourceMixer.stopAllAction();sourceMixer.uncacheRoot(library.scene);restoreTarget();
  }
  const mixer=new THREE.AnimationMixer(human);
  let current=null, disposed=false;
  function setPose(name) {
    const clip=clips.find(c=>c.name===name); if(!clip)throw new Error(`Unknown animation: ${name}`);
    const next=mixer.clipAction(clip); if(next===current)return;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if(current){current.fadeOut(.22);next.fadeIn(.22);} current=next;
  }
  const restPose = [...bones.values()].map(b=>[b,b.position.clone(),b.quaternion.clone(),b.scale.clone()]);
  function update(dt) {if(disposed)throw new Error('Character already disposed'); if(!Number.isFinite(dt)||dt<0)throw new RangeError('Invalid dt');mixer.update(Math.min(dt,.1));}
  function resetPose(){mixer.stopAllAction();current=null;for(const[b,p,q,s]of restPose){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}root.updateMatrixWorld(true);}
  function resources(object){const geometry=new Set(),material=new Set(),texture=new Set(),skeleton=new Set();object.traverse(o=>{if(o.geometry)geometry.add(o.geometry);if(o.skeleton)skeleton.add(o.skeleton);for(const m of [o.material].flat().filter(Boolean)){material.add(m);for(const value of Object.values(m))if(value?.isTexture)texture.add(value);}});return {geometry,material,texture,skeleton};}
  // Animation mannequin is not rendered or retained after retargeting.
  if (library) { const sourceResources=resources(library.scene);for(const kind of Object.values(sourceResources))for(const r of kind)r.dispose(); }
  human.traverse(o=>{if(o.isMesh){o.castShadow=o.receiveShadow=true;if(o.isSkinnedMesh)o.frustumCulled=false;}});
  const stats={bones:bones.size,animations:clips.map(c=>c.name),skinnedMeshes:0,triangles:0,meshes:0,weightedVertices:positions.count};
  root.traverse(o=>{if(o.isMesh){stats.meshes++;stats.triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;if(o.isSkinnedMesh)stats.skinnedMeshes++;}});
  function dispose(){if(disposed)return;disposed=true;mixer.stopAllAction();mixer.uncacheRoot(human);root.removeFromParent();for(const kind of Object.values(resources(root)))for(const r of kind)r.dispose();}
  return {root,body,bones,stats,clips,setPose,update,resetPose,setGear:visible=>gear.forEach(m=>{m.visible=visible;}),dispose};
}
