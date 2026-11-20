// Bundles the real arenaService with a test shim so it runs against the Firestore emulator.
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'entry.ts')],
  bundle: true, format: 'esm', platform: 'node',
  outfile: path.join(here, 'svc.mjs'),
  external: ['firebase/*'],
  plugins: [{ name: 'shim', setup(b) {
    b.onResolve({ filter: /^\.\.\/firebase$/ }, () => ({ path: path.join(here, 'shim.ts') }));
    b.onResolve({ filter: /^\.\/shim$/ }, () => ({ path: path.join(here, 'shim.ts') }));
  } }],
  logLevel: 'error',
});
