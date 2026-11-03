import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['server.mjs', 'server-neon.mjs', 'scripts/neon-smoke.mjs'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const html = await readFile(path.join(root, 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (!inlineScripts.length) throw new Error('No inline app scripts found in index.html.');
for (const [index, match] of inlineScripts.entries()) new Script(match[1], { filename: `index.html inline script ${index + 1}` });

const webDir = path.join(root, 'www');
await mkdir(webDir, { recursive: true });
await copyFile(path.join(root, 'index.html'), path.join(webDir, 'index.html'));
console.log(`Web app prepared for Android (${inlineScripts.length} inline scripts checked).`);
