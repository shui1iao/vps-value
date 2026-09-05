import crypto from 'node:crypto';
import path from 'node:path';
import { cp, mkdir, rm, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const temporary = path.join(root, `.dist-${process.pid}`);
const previous = path.join(root, `.dist-previous-${process.pid}`);
const names = ['app.mjs', 'control-adapter.mjs', 'controls.mjs', 'share-client.mjs', 'fx-client.mjs', 'styles.css', 'core.mjs'];
const files = await Promise.all(names.map((name) => readFile(path.join(root, name === 'core.mjs' ? 'src' : 'public', name))));
const html = await readFile(path.join(root, 'public/index.html'), 'utf8');
const hash = crypto.createHash('sha256').update(html);
files.forEach((file, index) => hash.update(names[index]).update(file));
const version = hash.digest('hex').slice(0, 12);
const assetBase = `/assets/${version}`;
// Refuse to traverse a deployed/static symlink: this command only builds its own tree.
const existing = await lstat(dist).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a dist symlink');
let movedPrevious = false;
try {
  await mkdir(temporary);
  await cp(path.join(root, 'public'), temporary, { recursive: true });
  const assets = path.join(temporary, 'assets', version);
  await mkdir(assets, { recursive: true });
  await Promise.all(names.map(async (name, index) => {
    await writeFile(path.join(assets, name), files[index]);
    await rm(path.join(temporary, name), { force: true });
  }));
  await writeFile(path.join(temporary, 'index.html'), html
    .replace('href="/styles.css"', `href="${assetBase}/styles.css"`)
    .replace('src="/app.mjs"', `src="${assetBase}/app.mjs"`));
  if (existing) { await rename(dist, previous); movedPrevious = true; }
  try { await rename(temporary, dist); }
  catch (error) { if (movedPrevious) await rename(previous, dist); throw error; }
  await rm(previous, { recursive: true, force: true });
  console.log(`Built dist/ — client ${version} (${names.length} versioned assets)`);
} finally { await rm(temporary, { recursive: true, force: true }); }
