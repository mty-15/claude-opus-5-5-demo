// 与其他游戏一致：esbuild 打包后将 JS/CSS 内联到单个 HTML。
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeTacticalAssets } from './tools/tactical-assets.mjs';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const template = await readFile('src/index.html', 'utf8');
const css = `${await readFile('src/style.css', 'utf8')}\n${await readFile('src/mobile.css', 'utf8')}`;
for (const placeholder of ['/*__CSS__*/', '/*__JS__*/']) {
  if (!template.includes(placeholder)) throw new Error(`Missing HTML placeholder: ${placeholder}`);
}
const tacticalAssets = await makeTacticalAssets();
const result = await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  define: { __TACTICAL_ASSETS__: JSON.stringify(tacticalAssets) },
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: !process.argv.includes('--dev'),
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const notices = (await Promise.all(['node_modules/three/LICENSE', 'character-preview/assets/LICENSE-CHARACTERS.txt', 'character-preview/assets/LICENSE-ANIMATIONS.txt'].map(p => readFile(p, 'utf8')))).join('\n\n');
const html = '<!--\n' + notices + '\n-->\n' + template.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', html);
console.log(`dist/index.html ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
