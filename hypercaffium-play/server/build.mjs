// Bundles the server (and the scheduled watcher) with their dependencies so installers do not need npm.
import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync('dist', { recursive: true, force: true });
for (const [entry, outfile] of [['index.js', 'dist/server.mjs'], ['watch.js', 'dist/watch.mjs']]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'info',
  });
}
fs.cpSync('spec', 'dist/spec', { recursive: true });
