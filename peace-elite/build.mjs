// 与其他游戏一致：esbuild 打包后将 JS/CSS 内联到单个 HTML。
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const template = await readFile('src/index.html', 'utf8');
const css = await readFile('src/style.css', 'utf8');
for (const placeholder of ['/*__CSS__*/', '/*__JS__*/']) {
  if (!template.includes(placeholder)) throw new Error(`Missing HTML placeholder: ${placeholder}`);
}
const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: !process.argv.includes('--dev'),
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', html);
console.log(`dist/index.html ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
