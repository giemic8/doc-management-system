import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const assetsDirectory = path.resolve('dist/assets');
const assetNames = await readdir(assetsDirectory);
const cssAssets = assetNames.filter((name) => name.endsWith('.css'));

if (cssAssets.length === 0) {
  throw new Error('Frontend build produced no CSS asset');
}

const css = (
  await Promise.all(cssAssets.map((name) => readFile(path.join(assetsDirectory, name), 'utf8')))
).join('\n');

const requiredUtilities = [
  ['hidden', /\.hidden\{[^}]*display:none/],
  ['flex', /\.flex\{[^}]*display:flex/],
  ['fixed sidebar width', /\.w-64\{/],
  ['responsive document grid', /\.md\\:grid-cols-2\{/],
];

const missingUtilities = requiredUtilities
  .filter(([, pattern]) => !pattern.test(css))
  .map(([name]) => name);

if (missingUtilities.length > 0) {
  throw new Error(`Compiled CSS is missing required utilities: ${missingUtilities.join(', ')}`);
}

if (Buffer.byteLength(css, 'utf8') < 10_000) {
  throw new Error('Compiled CSS is unexpectedly small; utility generation may be disabled');
}

console.log(`Verified ${cssAssets.length} CSS asset(s), ${Buffer.byteLength(css, 'utf8')} bytes`);
