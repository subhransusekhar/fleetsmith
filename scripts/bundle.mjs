// Bundle the ESM CLI + its single runtime dep (`yaml`) into one CommonJS
// file that Node's SEA (Single Executable Application) can embed. esbuild is
// a build-time devDependency only — it never ships to npm consumers, and the
// resulting binary is fully self-contained (zero runtime dependencies).
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/cli.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/fleetsmith.cjs',
  // Keep Node built-ins external (they exist in every runtime); inline the rest.
  // No shebang banner: SEA executes the blob directly, and `node dist/fleetsmith.cjs`
  // works without one. Inject the version so `version` works in the binary,
  // which has no package.json on disk beside it.
  define: {
    __FLEETSMITH_VERSION__: JSON.stringify(version),
    // esbuild cannot fill `import.meta` in for the cjs format — it substitutes
    // an empty object, so `import.meta.url` silently becomes undefined and, in
    // v0.7.0, took `createRequire(undefined)` down with it on EVERY command.
    // Defining it explicitly makes that substitution a stated contract rather
    // than a build warning nobody reads; `MODULE_URL` in src/cli.js is the one
    // place that reads it, and every consumer branches off that.
    'import.meta.url': 'undefined',
  },
  // A new `import.meta` use that is NOT routed through MODULE_URL is a bug of
  // exactly the shape above, so fail the build rather than warn about it.
  logOverride: { 'empty-import-meta': 'error' },
});

console.log('bundled -> dist/fleetsmith.cjs');
