import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTacticalCharacter} from './tactical-character.js';

// No DOM or GPU is needed for deformation/retargeting regressions. Shader,
// image decoding and actual presentation are verified separately in Chrome.
if(!globalThis.ProgressEvent)globalThis.ProgressEvent=class ProgressEvent extends Event{constructor(type,init={}){super(type);Object.assign(this,init);}};
const read=path=>readFile(new URL(path,import.meta.url));
const bodyJSON=JSON.parse(await read('assets/Superhero_Male_FullBody.gltf'));
const bodyBin=await read('assets/Superhero_Male_FullBody.bin');
const animationGLB=await read('assets/AnimationLibrary.glb');
assert.equal(createHash('sha256').update(bodyBin).digest('hex'),'459003f9745853ae562a85506a2b94dd56515c1f37728f9fa3d2ce1a3e4cd92f');
assert.equal(createHash('sha256').update(animationGLB).digest('hex'),'1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c');
const animationJSON=JSON.parse(animationGLB.subarray(20,20+animationGLB.readUInt32LE(12)).toString());
const jsonEnd=20+animationGLB.readUInt32LE(12);
const animationBin=animationGLB.subarray(jsonEnd+8,jsonEnd+8+animationGLB.readUInt32LE(jsonEnd));
function withoutImages(json,bin){
  const clone=structuredClone(json);delete clone.images;delete clone.textures;delete clone.samplers;
  for(const m of clone.materials||[]){delete m.normalTexture;delete m.occlusionTexture;delete m.emissiveTexture;delete m.extensions;delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;}
  clone.buffers[0].uri='data:application/octet-stream;base64,'+bin.toString('base64');return clone;
}
const model=await createTacticalCharacter(withoutImages(bodyJSON,bodyBin),JSON.stringify(withoutImages(animationJSON,animationBin)));
let count=0;
function test(name,fn){fn();console.log('PASS '+name);count++;}
function sample(){
  model.root.updateMatrixWorld(true);model.body.skeleton.update();
  const mesh=model.body,v=mesh.position.clone(),samples=[];let minY=Infinity,maxY=-Infinity;
  for(let i=0;i<mesh.geometry.attributes.position.count;i++){
    mesh.getVertexPosition(i,v);v.applyMatrix4(mesh.matrixWorld);minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);
    if(i%97===0)samples.push(...v.toArray());
  }
  return {samples,minY,maxY,hipY:model.bones.get('pelvis').matrixWorld.elements[13]};
}
const rest=sample();
const bonePositions=new Map([...model.bones].filter(([n])=>n!=='pelvis').map(([n,b])=>[n,b.position.toArray()]));
const geometries=new Set(),materials=new Set(),skeletons=new Set();
model.root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)materials.add(o.material);if(o.skeleton)skeletons.add(o.skeleton);});
test('continuous body is a weighted SkinnedMesh with authored topology',()=>{assert.ok(model.body.isSkinnedMesh);assert.equal(model.body.geometry.attributes.position.count,7281);assert.equal(model.body.geometry.index.count/3,12566);assert.equal(model.stats.bones,65);});
test('standing bind soles and body height remain in metre scale',()=>{assert.ok(rest.minY>=-.02&&rest.minY<=.02);assert.ok(rest.maxY>1.70&&rest.maxY<1.76);});
test('hard equipment does not explode the preview triangle budget',()=>assert.ok(model.stats.triangles<25000));
test('only six genuinely mapped clips are exposed',()=>{assert.equal(model.clips.length,6);for(const clip of model.clips){assert.equal(clip.tracks.length,54);for(const name of ['upperarm_l','upperarm_r','calf_l','calf_r','Head'])assert.ok(clip.tracks.some(t=>t.name===name+'.quaternion'));assert.ok(clip.tracks.some(t=>t.name==='pelvis.position'));}});
let standing;
for(const name of ['Idle_Loop','Walk_Loop','Jog_Fwd_Loop','Crouch_Idle_Loop','Pistol_Aim_Neutral']){
  model.resetPose();model.setPose(name);for(let i=0;i<20;i++)model.update(.05);const state=sample();
  test(name+' changes actual skinned vertices, not merely the clip count',()=>assert.ok(Math.max(...state.samples.map((v,i)=>Math.abs(v-rest.samples[i])))>.03));
  test(name+' retains target bone lengths and finite world transforms',()=>{for(const[n,p]of bonePositions)assert.deepEqual(model.bones.get(n).position.toArray(),p);model.root.traverse(o=>assert.ok(o.matrixWorld.elements.every(Number.isFinite)));assert.ok(state.samples.every(Number.isFinite));});
  if(name==='Idle_Loop')standing=state;
  if(name==='Crouch_Idle_Loop')test('crouch preserves a real pelvis descent and lower head silhouette',()=>{assert.ok(state.hipY<standing.hipY-.25);assert.ok(state.maxY<standing.maxY-.25);assert.ok(state.minY>-.06&&state.minY<.10);});
}
model.resetPose();model.setPose('Walk_Loop');for(let i=0;i<6;i++)model.update(.05);const a=sample();for(let i=0;i<6;i++)model.update(.05);const b=sample();
test('walk changes over time rather than freezing in one pose',()=>assert.ok(Math.max(...b.samples.map((v,i)=>Math.abs(v-a.samples[i])))>.03));
test('updates reuse mesh geometry and materials',()=>{model.root.traverse(o=>{if(o.geometry)assert.ok(geometries.has(o.geometry));if(o.material)assert.ok(materials.has(o.material));});});
test('invalid dt and unknown animation fail explicitly',()=>{assert.throws(()=>model.update(NaN),RangeError);assert.throws(()=>model.update(-1),RangeError);assert.throws(()=>model.setPose('nonexistent'),/Unknown animation/);});
let geometryDisposals=0,materialDisposals=0,boneTextureDisposals=0;
for(const g of geometries)g.addEventListener('dispose',()=>geometryDisposals++);
for(const m of materials)m.addEventListener('dispose',()=>materialDisposals++);
for(const s of skeletons){s.computeBoneTexture();s.boneTexture.addEventListener('dispose',()=>boneTextureDisposals++);}
model.dispose();model.dispose();
test('repeated disposal frees each owned geometry/material only once',()=>{assert.equal(geometryDisposals,geometries.size);assert.equal(materialDisposals,materials.size);});
test('rendering skeleton textures are explicitly freed only once',()=>{assert.equal(boneTextureDisposals,skeletons.size);for(const s of skeletons)assert.equal(s.boneTexture,null);});
test('updates reject a disposed character',()=>assert.throws(()=>model.update(.016),/already disposed/));
console.log(`Character preview: ${count} tests passed; source hashes verified.`);
