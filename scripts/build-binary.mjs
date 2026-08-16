// Build a standalone native executable using Node's built-in Single
// Executable Application (SEA) support — no runtime dependencies, no Node
// required on the target machine. Runs on the current platform; the release
// workflow runs it on linux/macos/windows runners to produce all artifacts.
//
// Pipeline: bundle (esbuild) -> SEA blob -> obtain node binary -> inject blob
// (postject) -> (re)sign on macOS. postject is a build-time devDependency.
//
// macOS cross-building: pass `--arch x64` (or arm64) to build for the other
// Apple architecture. Injection is pure Mach-O surgery — postject rewrites the
// file and never executes it, and `codesign` signs any architecture — so an
// arm64 host can produce a working Intel binary. What it cannot do is reuse the
// host's own node: CI installs an architecture-specific build, so the target
// architecture's official node is downloaded and used as the injection base.
// This exists because GitHub's Intel macOS runners queue indefinitely; building
// both slices on one arm64 runner avoids depending on them.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const argArch = (() => {
  const i = process.argv.indexOf('--arch');
  return i > -1 ? process.argv[i + 1] : process.env.FLEETSMITH_TARGET_ARCH;
})();
const targetArch = argArch ?? process.arch;
const crossBuild = targetArch !== process.arch;

if (crossBuild && !isMac) {
  throw new Error(`--arch cross-building is only supported on macOS (host is ${process.platform})`);
}
if (!['x64', 'arm64'].includes(targetArch)) {
  throw new Error(`unsupported --arch "${targetArch}" (use x64 or arm64)`);
}

// The SEA fuse sentinel is baked into each node build and its exact hash
// varies by version, so detect it from the (thinned) binary rather than
// hardcoding the documented default.
function detectFuse(bin) {
  const m = readFileSync(bin).toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]+/);
  if (!m) throw new Error(`SEA fuse sentinel not found in ${bin}`);
  return m[0];
}

const outDir = 'dist/bin';
mkdirSync(outDir, { recursive: true });
// Cross-built artifacts get an arch suffix so both macOS slices can coexist in
// dist/bin; the native build keeps the plain name the release workflow expects.
const binPath = path.join(
  outDir,
  isWin ? 'fleetsmith.exe' : crossBuild ? `fleetsmith-${targetArch}` : 'fleetsmith'
);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// 1. Bundle to a single CJS file.
//
// Always re-bundle. This used to be skipped when `dist/fleetsmith.cjs` already
// existed, which quietly injects a STALE bundle whenever this script is run on
// its own — `node scripts/build-binary.mjs` after a source edit produced a
// binary built from the previous edit, with no output saying so. `npm run
// build:binary` masked it by running the bundler first, so the footgun only
// fired outside the npm script, which is exactly where a release engineer
// debugging a bad binary would be. Bundling costs well under a second.
run(process.execPath, ['scripts/bundle.mjs']);

// 2. Generate the SEA blob.
writeFileSync(
  'dist/sea-config.json',
  JSON.stringify(
    { main: 'dist/fleetsmith.cjs', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true },
    null,
    2
  )
);
run(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json']);

// 3. Obtain the node binary that will carry the payload.
if (crossBuild) {
  copyFileSync(downloadNode(targetArch), binPath);
} else {
  copyFileSync(process.execPath, binPath);
}

// 3b. macOS: postject can't inject into a universal (fat) Mach-O, and the
// official node ships fat in some distributions. Thin to the target slice.
if (isMac) {
  const arch = targetArch === 'arm64' ? 'arm64' : 'x86_64';
  try {
    const archs = execFileSync('lipo', ['-archs', binPath], { encoding: 'utf8' }).trim();
    if (archs.split(/\s+/).length > 1) {
      run('lipo', ['-thin', arch, binPath, '-output', binPath]);
    } else if (archs && archs !== arch) {
      throw new Error(`node binary is ${archs}, expected ${arch} — refusing to mislabel the artifact`);
    }
  } catch (e) {
    if (e.message?.includes('refusing to mislabel')) throw e;
    /* not a fat binary — nothing to thin */
  }
}

// 4. macOS: strip the signature before injecting.
if (isMac) {
  try {
    run('codesign', ['--remove-signature', binPath]);
  } catch {
    /* unsigned build host — fine */
  }
}

// 5. Inject the blob with postject, matching the fuse baked into this build.
// Invoke postject's JS entry directly with node — the `.bin/postject.cmd`
// shim can't be spawned by execFileSync on Windows (EINVAL).
const fuse = detectFuse(binPath);
const postjectCli = path.join('node_modules', 'postject', 'dist', 'cli.js');
const postjectArgs = [binPath, 'NODE_SEA_BLOB', 'dist/sea-prep.blob', '--sentinel-fuse', fuse];
if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, [postjectCli, ...postjectArgs]);

// 6. macOS: ad-hoc re-sign so Gatekeeper will run it.
if (isMac) {
  try {
    run('codesign', ['--sign', '-', binPath]);
  } catch {
    /* fine */
  }
}

if (!isWin) chmodSync(binPath, 0o755);
console.log(`built ${binPath} for ${process.platform}/${targetArch}${crossBuild ? ` (cross-built on ${process.arch})` : ''}`);

/**
 * Fetch the official node build for another macOS architecture and return the
 * path to its `node` binary.
 *
 * The version is pinned to the running node so the SEA blob, the fuse sentinel,
 * and the runtime all come from one release — a mismatch there produces a
 * binary that either refuses to start or silently runs the wrong payload.
 */
function downloadNode(arch) {
  const version = process.version; // e.g. v22.14.0
  const name = `node-${version}-darwin-${arch}`;
  const cacheDir = path.join('dist', '.node-cache');
  const nodeBin = path.join(cacheDir, name, 'bin', 'node');
  if (existsSync(nodeBin)) return nodeBin;

  mkdirSync(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, `${name}.tar.gz`);
  const url = `https://nodejs.org/dist/${version}/${name}.tar.gz`;
  console.log(`fetching ${url}`);
  run('curl', ['-fsSL', '--retry', '3', '-o', tarball, url]);
  run('tar', ['-xzf', tarball, '-C', cacheDir]);
  rmSync(tarball, { force: true });

  if (!existsSync(nodeBin)) throw new Error(`expected ${nodeBin} in the extracted tarball`);
  return nodeBin;
}
