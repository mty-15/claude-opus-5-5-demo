import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const files = [...readdirSync('src').filter(f => f.endsWith('.js')).map(f => `src/${f}`), ...readdirSync('.').filter(f => f.endsWith('.mjs'))];
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0 || result.error) { console.error(file, result.stderr || result.error); failed = true; }
  for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g)) {
    if (!existsSync(resolve(dirname(file), match[1]))) { console.error(`Unresolved import ${file}: ${match[1]}`); failed = true; }
  }
}
console.log(`Checked ${files.length} JavaScript files: ${failed ? 'FAILED' : 'OK'}`);
process.exitCode = failed ? 1 : 0;
