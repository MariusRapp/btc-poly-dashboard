// The page loads modules from a static host: every module must be preloaded, every import must resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

test('index.html preloads exactly the modules in js/', () => {
  const html = read('index.html');
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="js\/([\w-]+\.js)"/g)].map(m => m[1]).sort();
  const files = readdirSync(new URL('js/', root)).filter(f => f.endsWith('.js')).sort();
  assert.deepEqual(preloaded, files);
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
});

test('relative imports point at existing files', () => {
  for (const f of readdirSync(new URL('js/', root)).filter(f => f.endsWith('.js'))) {
    for (const [, spec] of read('js/' + f).matchAll(/^import .* from '(\.[^']+)';$/gm))
      assert.ok(existsSync(new URL(spec, new URL('js/' + f, root))), `${f} imports missing ${spec}`);
  }
});
