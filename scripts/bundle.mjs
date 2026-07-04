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
  },
});

console.log('bundled -> dist/fleetsmith.cjs');
