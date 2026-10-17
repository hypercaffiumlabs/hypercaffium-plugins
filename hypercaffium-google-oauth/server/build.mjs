// Bundles the server (and the SessionStart check) with their dependencies so installers do not need npm.
import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync('dist', { recursive: true, force: true });
for (const [entry, outfile] of [
  ['index.js', 'dist/server.mjs'],
  ['setup.js', 'dist/setup.mjs'],
  ['session-check.js', 'dist/session-check.mjs'],
]) {
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
// Built-in recipes are read at runtime next to the bundle, so they are copied alongside it.
fs.cpSync('recipes', 'dist/recipes', { recursive: true });
