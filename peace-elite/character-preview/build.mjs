import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=fileURLToPath(new URL('.',import.meta.url));
process.chdir(root);
const model=JSON.parse(await readFile('assets/Superhero_Male_FullBody.gltf','utf8'));
const bodyBuffer=await readFile('assets/Superhero_Male_FullBody.bin');
model.buffers[0].uri=`data:application/octet-stream;base64,${bodyBuffer.toString('base64')}`;
// Original eyebrow normal and packed roughness images are excluded from this
// prototype. No missing URI reaches GLTFLoader; skin's normal map is retained.
delete model.materials[0].normalTexture;
delete model.materials[2].pbrMetallicRoughness.metallicRoughnessTexture;
const needed=new Set([1,2,3,4,5]);
for(let i=0;i<model.images.length;i++){
  if(needed.has(i)){
    const bytes=await readFile(`assets/${model.images[i].uri}`);
    model.images[i].uri=`data:image/png;base64,${bytes.toString('base64')}`;
  }else{
    // These entries are no longer referenced by a material.
    model.images[i].uri='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFuoAAAAASUVORK5CYII=';
  }
}
const animation=await readFile('assets/AnimationLibrary.glb');
const payload={model,animation:animation.toString('base64'),provenance:{author:'Quaternius',license:'CC0-1.0',model:'https://quaternius.com/packs/universalbasecharacters.html',animations:'https://quaternius.com/packs/universalanimationlibrary.html',modelBufferSHA256:createHash('sha256').update(bodyBuffer).digest('hex'),animationSHA256:createHash('sha256').update(animation).digest('hex')}};
const result=await build({absWorkingDir:root,entryPoints:['./main.js'],bundle:true,format:'iife',target:['es2020'],minify:true,write:false,legalComments:'none'});
const template=await readFile('template.html','utf8');
for(const marker of ['/*__PAYLOAD__*/','/*__JS__*/'])if(!template.includes(marker))throw new Error(`Missing marker: ${marker}`);
const notices=(await Promise.all(['../node_modules/three/LICENSE','assets/LICENSE-CHARACTERS.txt','assets/LICENSE-ANIMATIONS.txt'].map(p=>readFile(p,'utf8')))).join('\n\n');
const html='<!--\n'+notices+'\n-->\n'+template.replace('/*__PAYLOAD__*/',()=>JSON.stringify(payload).replace(/</g,'\\u003c')).replace('/*__JS__*/',()=>result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
await writeFile('index.html',html);
console.log(`character-preview/index.html: ${(Buffer.byteLength(html)/1024/1024).toFixed(2)} MiB; all runtime resources embedded; game build unchanged`);
