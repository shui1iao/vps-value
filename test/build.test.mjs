import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, appendFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('build versions the complete client module graph and changes URLs with core changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vps-build-'));
  try {
    for (const dir of ['scripts', 'src']) await mkdir(path.join(root, dir));
    await cp(new URL('../public', import.meta.url), path.join(root, 'public'), { recursive: true });
    await cp(new URL('../src/core.mjs', import.meta.url), path.join(root, 'src/core.mjs'));
    await cp(new URL('../scripts/build.mjs', import.meta.url), path.join(root, 'scripts/build.mjs'));
    const build = () => execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
    build();
    const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
    const assetPath = html.match(/src="(\/assets\/[a-f0-9]{12}\/app\.mjs)"/)?.[1];
    assert.ok(assetPath, 'HTML must reference versioned client assets');
    const assetDir = path.dirname(path.join(root, 'dist', assetPath));
    assert.match(html, new RegExp(`href="/assets/${path.basename(assetDir)}/styles.css"`));
    assert.deepEqual((await readdir(assetDir)).sort(), ['app.mjs', 'control-adapter.mjs', 'controls.mjs', 'core.mjs', 'fx-client.mjs', 'share-client.mjs', 'styles.css']);
    const app = await readFile(path.join(assetDir, 'app.mjs'), 'utf8');
    assert.match(app, /from '\.\/core.mjs'/);
    assert.match(app, /from '\.\/control-adapter.mjs'/);
    const adapter = await readFile(path.join(assetDir, 'control-adapter.mjs'), 'utf8');
    assert.match(adapter, /from '\.\/controls.mjs'/);
    await appendFile(path.join(root, 'public/control-adapter.mjs'), '\n// changed capability contract\n');
    build();
    const adapterChangedHtml = await readFile(path.join(root, 'dist/index.html'), 'utf8');
    assert.ok(!adapterChangedHtml.includes(assetPath));
    await appendFile(path.join(root, 'src/core.mjs'), '\n// changed core contract\n');
    build();
    const changedHtml = await readFile(path.join(root, 'dist/index.html'), 'utf8');
    assert.notEqual(changedHtml, adapterChangedHtml);
    assert.ok((await readdir(root)).every((name) => !name.startsWith('.dist-')), 'build leaves no temporary artifacts');
  } finally { await rm(root, { recursive: true, force: true }); }
});
