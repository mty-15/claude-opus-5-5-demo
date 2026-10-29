import * as THREE from 'three';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTacticalCharacter} from '../character-preview/tactical-character.js';

const assets = new URL('../character-preview/assets/', import.meta.url);
const SOURCE_BLOBS = {
  'Superhero_Male_FullBody.gltf':'0dc21ed7952950f83bf19d3cab63110534460c54',
  'T_Hair_1_BaseColor.png':'c398ca7d10a12d0a1c3fb19d459280bde868594b',
  'T_Eye_Brown.png':'0d037febc2789c86fdb40d7ccd4c0a1d0591cfbe',
  'T_Eye_Normal.png':'2da59128bac4b6d4a87fc0ee1d1835cd52e21028',
  'T_Superhero_Male_Normal.png':'88303e2ad3f435853cd10d509adbbae960af4279',
  'T_Superhero_Male_Dark.png':'6391f45275f6c904edbde5daa500bab26b103366',
};
const read = async name => {
  const data = await readFile(new URL(name, assets));
  if (SOURCE_BLOBS[name] && createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex') !== SOURCE_BLOBS[name]) throw new Error('Licensed character source hash mismatch: '+name);
  return data;
};
const NAMES = ['Idle_Loop','Walk_Loop','Jog_Fwd_Loop','Crouch_Idle_Loop','Crouch_Fwd_Loop','Pistol_Aim_Neutral','Death01','Jump_Loop','Swim_Idle_Loop','Swim_Fwd_Loop'];
function noImages(json, bytes) {
  const result = structuredClone(json);
  delete result.images; delete result.textures; delete result.samplers;
  for (const m of result.materials || []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture; delete m.extensions;
    delete m.pbrMetallicRoughness?.baseColorTexture; delete m.pbrMetallicRoughness?.metallicRoughnessTexture;
  }
  result.buffers[0].uri = 'data:application/octet-stream;base64,' + bytes.toString('base64');
  return result;
}
const packed = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');

// Build-time only: verify source bytes, retarget once, bake foot grounding into
// a separate visual pivot. Runtime physics/root motion is never imported.
export async function makeTacticalAssets({textures = true} = {}) {
  if (!globalThis.ProgressEvent) globalThis.ProgressEvent = class extends Event {constructor(type, init={}) {super(type); Object.assign(this, init);}};
  const raw = JSON.parse(await read('Superhero_Male_FullBody.gltf'));
  const bytes = await read('Superhero_Male_FullBody.bin');
  const animation = await read('AnimationLibrary.glb');
  const sha = data => createHash('sha256').update(data).digest('hex');
  if (sha(bytes) !== '459003f9745853ae562a85506a2b94dd56515c1f37728f9fa3d2ce1a3e4cd92f' || sha(animation) !== '1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c') throw new Error('Licensed character source hash mismatch');
  const jsonLength = animation.readUInt32LE(12), binStart = 20 + jsonLength;
  const animationJSON = JSON.parse(animation.subarray(20, binStart).toString());
  const animationBin = animation.subarray(binStart + 8, binStart + 8 + animation.readUInt32LE(binStart));
  const naked = noImages(raw, bytes);
  const prototype = await createTacticalCharacter(naked, JSON.stringify(noImages(animationJSON, animationBin)), {clipNames:NAMES});
  const mixer = new THREE.AnimationMixer(prototype.root), vertex = new THREE.Vector3();
  const clips = [];
  try {
    for (const clip of prototype.clips) {
      mixer.stopAllAction(); prototype.resetPose();
      const sourceClip=clip.name==='Swim_Idle_Loop'?prototype.clips.find(c=>c.name==='Idle_Loop'):clip;
      const action = mixer.clipAction(sourceClip).setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
      const times = sourceClip.tracks[0].times, offsets = new Float32Array(times.length);
      const prone=clip.name.startsWith('Swim_'), tracks=sourceClip.tracks.map(t=>t.clone());
      const pelvis=prototype.bones.get('pelvis'),head=prototype.bones.get('Head');
      const savedPelvis=pelvis.quaternion.clone(),savedHead=head.quaternion.clone();
      const rotation=new THREE.Quaternion(),parentQ=new THREE.Quaternion(),worldQ=new THREE.Quaternion(),xAxis=new THREE.Vector3(1,0,0);
      const hipPoint=new THREE.Vector3(),bodyAxis=new THREE.Vector3(),forward=new THREE.Vector3(0,0,1);
      prototype.root.updateMatrixWorld(true);const referenceHead=prototype.bones.get('Head').getWorldQuaternion(new THREE.Quaternion());
      const proneHead=new THREE.Quaternion().setFromAxisAngle(xAxis,.22).multiply(referenceHead);
      const meshes=[];prototype.root.traverseVisible(o=>{if(o.isMesh)meshes.push(o);});
      for (let frame = 0; frame < times.length; frame++) {
        if(prone){pelvis.quaternion.copy(savedPelvis);head.quaternion.copy(savedHead);}
        mixer.setTime(Math.min(times[frame], sourceClip.duration - 1e-6)); prototype.root.updateMatrixWorld(true);
        if(prone){
          savedPelvis.copy(pelvis.quaternion);savedHead.copy(head.quaternion);
          pelvis.getWorldPosition(hipPoint);head.getWorldPosition(bodyAxis);bodyAxis.sub(hipPoint).normalize();
          pelvis.getWorldQuaternion(worldQ);rotation.setFromUnitVectors(bodyAxis,forward);worldQ.premultiply(rotation);
          pelvis.parent.getWorldQuaternion(parentQ);pelvis.quaternion.copy(parentQ.invert().multiply(worldQ));pelvis.updateMatrixWorld(true);
          head.parent.getWorldQuaternion(parentQ);head.quaternion.copy(parentQ.invert().multiply(proneHead));head.updateMatrixWorld(true);
          for(const [name,bone]of [['pelvis',pelvis],['Head',head]])bone.quaternion.toArray(tracks.find(t=>t.name===name+'.quaternion').values,frame*4);
        }
        let minY = Infinity;
        for(const mesh of meshes)for(let i=0;i<mesh.geometry.attributes.position.count;i++){
          mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
          minY = Math.min(minY, vertex.y);
        }
        offsets[frame] = .006 - minY;
      }
      tracks.push(new THREE.NumberKeyframeTrack('tactical-ground.position[y]', times.slice(), offsets));
      const name=prone?(clip.name==='Swim_Idle_Loop'?'Prone_Idle':'Prone_Move'):clip.name;
      clips.push({name, duration:sourceClip.duration, tracks:tracks.map(t => ({name:t.name,type:t.ValueTypeName,times:packed(t.times),values:packed(t.values)}))});
    }
  } finally {mixer.stopAllAction(); mixer.uncacheRoot(prototype.root); prototype.dispose();}
  if (clips.length !== NAMES.length) throw new Error('Missing game posture animation');
  let model = naked;
  if (textures) {
    model = structuredClone(raw); model.buffers[0].uri = naked.buffers[0].uri;
    delete model.materials[0].normalTexture;
    delete model.materials[2].pbrMetallicRoughness.metallicRoughnessTexture;
    const needed = new Set([1,2,3,4,5]);
    for (let i=0; i<model.images.length; i++) {
      model.images[i].uri = needed.has(i) ? 'data:image/png;base64,' + (await read(raw.images[i].uri)).toString('base64') : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFuoAAAAASUVORK5CYII=';
    }
  }
  return {model, clips, source:{author:'Quaternius',license:'CC0-1.0',model:'https://quaternius.com/packs/universalbasecharacters.html',animations:'https://quaternius.com/packs/universalanimationlibrary.html',modelSHA256:sha(bytes),animationSHA256:sha(animation)}};
}
