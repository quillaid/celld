import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('.', import.meta.url);
const lock = JSON.parse(await readFile(new URL('sdk-lock.json', root), 'utf8'));
const target = new URL('.celld/' + lock.filename, root);
await mkdir(new URL('.celld/', root), { recursive: true });
let bytes;
try { bytes = await readFile(target); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(lock.url);
  if (!response.ok) throw new Error(`SDK download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('SDK artifact hash mismatch');
await writeFile(target, bytes);
console.log(`Verified ${lock.name} ${lock.version}: ${lock.sha256}`);
