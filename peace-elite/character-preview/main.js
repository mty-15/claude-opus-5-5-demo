import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createSoldier } from '../src/models.js';
import { createTacticalCharacter } from './tactical-character.js';

const $ = id => document.getElementById(id);
const failures = [];
function report(error) {const text = error?.stack || String(error);failures.push(text);$('error').textContent=text;$('error').style.display='block';$('status').style.display='none';}
addEventListener('error', e => report(e.error || e.message));
addEventListener('unhandledrejection', e => report(e.reason));

async function start() {
  const payload = JSON.parse($('payload').textContent);
  const binary = Uint8Array.from(atob(payload.animation), c=>c.charCodeAt(0)).buffer;
  const tactical = await createTacticalCharacter(payload.model, binary);
  const old = createSoldier({player:true});
  old.update({dt:0,weapon:null});
  // Imported humanoid faces +Z, game model faces -Z. Only the display mount
  // rotates the new model; future game integration would normalize this once.
  const newMount = new THREE.Group(), oldMount = new THREE.Group();
  newMount.add(tactical.root); tactical.root.rotation.y=Math.PI;
  oldMount.add(old.root); oldMount.visible=false;
  const scene = new THREE.Scene(); scene.background=new THREE.Color(0x17232a);
  scene.add(newMount,oldMount);
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight,false);
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  $('stage').appendChild(renderer.domElement);
  const environment = new RoomEnvironment();
  const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(environment,.04);
  scene.environment=env.texture;scene.environmentIntensity=.65;environment.dispose();pmrem.dispose();
  const hemi=new THREE.HemisphereLight(0xc8e4ed,0x617268,2.1);scene.add(hemi);
  const key=new THREE.DirectionalLight(0xffefd4,3.6);key.position.set(-2.2,4.5,-3);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-2;key.shadow.camera.right=2;key.shadow.camera.top=2.4;key.shadow.camera.bottom=-1.3;key.shadow.bias=-.00015;key.shadow.normalBias=.018;scene.add(key);
  const rim=new THREE.DirectionalLight(0x9ddcda,2.5);rim.position.set(2,2.3,2.2);scene.add(rim);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x26383b,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.014;floor.receiveShadow=true;scene.add(floor);
  const camera=new THREE.PerspectiveCamera(32,innerWidth/innerHeight,.01,100);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=.45;controls.maxDistance=6;controls.maxPolarAngle=Math.PI*.54;
  let comparison=false,detail=false,paused=false,gear=true,pose='rest',elapsed=0;
  const poseChoices=[['rest','自然站姿（静态）'],['idle','待机'],['walk','行走'],['run','跑步'],['crouch','蹲姿'],['gun','持枪动作（未配枪）']];
  const selected=new Map();
  const exact={idle:'Idle_Loop',walk:'Walk_Loop',run:'Jog_Fwd_Loop',crouch:'Crouch_Idle_Loop',gun:'Pistol_Aim_Neutral'};
  for(const[name,clipName]of Object.entries(exact))if(tactical.clips.some(c=>c.name===clipName&&c.tracks.length>=50))selected.set(name,clipName);
  const poseSelect=$('pose');poseSelect.replaceChildren();
  for(const[value,label]of poseChoices)if(value==='rest'||selected.has(value)){
    const option=document.createElement('option');option.value=value;option.textContent=label;poseSelect.append(option);
  }
  function frameView(){
    const portrait=innerWidth<innerHeight;
    const targetY=detail?1.44:.91;
    const panelHeight=$('compare').closest('.panel').getBoundingClientRect().height+24;
    const visibleHeight=Math.max(innerHeight*.40,innerHeight-panelHeight);
    const distance=(detail?1.65:portrait?4.45:3.65)*innerHeight/visibleHeight;
    controls.target.set(0,targetY,0);camera.position.set(detail?.14:.25,targetY+.10,-distance);
    camera.setViewOffset(innerWidth,innerHeight,0,panelHeight/2,innerWidth,innerHeight);
    camera.fov=comparison?39:32;camera.updateProjectionMatrix();controls.update();
  }
  function setPose(value){
    pose=value;tactical.resetPose();
    if(value==='rest'){
      tactical.setPose(selected.get('idle'));
      for(let i=0;i<10;i++)tactical.update(.1);
    }else tactical.setPose(selected.get(value));
    poseSelect.value=value;
  }
  function relaxed(){setPose('rest');}
  function setCompare(value){comparison=value;oldMount.visible=value;newMount.position.x=value?-.62:0;oldMount.position.x=.62;$('compare').setAttribute('aria-pressed',String(value));$('old-label').style.display=value?'block':'none';$('new-label').style.left=value?'68%':'50%';frameView();}
  function setView(value){detail=value==='detail';$('view').value=value;frameView();}
  $('view').onchange=e=>setView(e.target.value);
  poseSelect.onchange=e=>setPose(e.target.value);
  $('angle').oninput=e=>{const a=Number(e.target.value)*Math.PI/180;newMount.rotation.y=oldMount.rotation.y=a;};
  $('compare').onclick=()=>setCompare(!comparison);
  $('gear').onclick=()=>{gear=!gear;tactical.setGear(gear);$('gear').textContent=`装备：${gear?'显示':'隐藏'}`;$('gear').setAttribute('aria-pressed',String(gear));};
  $('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'播放动作':'暂停动作';$('pause').setAttribute('aria-pressed',String(paused));};
  const onResize=()=>{renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();frameView();};
  addEventListener('resize',onResize);
  const stats=tactical.stats;
  $('metrics').innerHTML=`${stats.bones} 骨骼 · ${stats.skinnedMeshes} 蒙皮网格<br>${stats.weightedVertices.toLocaleString()} 人体顶点 · ${Math.round(stats.triangles).toLocaleString()} 总三角形<br>${stats.animations.length} 可用动作 · 单人预览，非手机帧率证明`;
  $('status').style.display='none';
  relaxed();frameView();
  const clock=new THREE.Clock();
  function render(dt){
    if(!paused&&pose!=='rest')tactical.update(dt);
    elapsed+=dt;
    old.update({dt:paused?0:dt,speed:pose==='run'?4.4:pose==='walk'?2:0,crouch:pose==='crouch',weapon:null});
    controls.update();renderer.render(scene,camera);
  }
  renderer.setAnimationLoop(()=>render(Math.min(clock.getDelta(),.05)));
  window.__characterPreview={tactical,old,scene,renderer,camera,controls,newMount,oldMount,failures,selected:Object.fromEntries(selected),setPose,setView,setCompare,render,
    freeze(){renderer.setAnimationLoop(null);},
    snapshot(){return {stats,selected:Object.fromEntries(selected),pose,comparison,detail,failures,render:renderer.info.render,source:payload.provenance};},
    dispose(){renderer.setAnimationLoop(null);removeEventListener('resize',onResize);controls.dispose();tactical.dispose();old.dispose();floor.geometry.dispose();floor.material.dispose();key.shadow.dispose();env.dispose();renderer.dispose();renderer.domElement.remove();}
  };
}
start().catch(report);
