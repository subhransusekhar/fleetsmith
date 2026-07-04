// Build a standalone native executable using Node's built-in Single
// Executable Application (SEA) support — no runtime dependencies, no Node
// required on the target machine. Runs on the current platform; the release
// workflow runs it on linux/macos/windows runners to produce all artifacts.
//
// Pipeline: bundle (esbuild) -> SEA blob -> copy node binary -> inject blob
// (postject) -> (re)sign on macOS. postject is a build-time devDependency.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

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
const binPath = path.join(outDir, isWin ? 'fleetsmith.exe' : 'fleetsmith');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// 1. Bundle to a single CJS file.
if (!existsSync('dist/fleetsmith.cjs')) {
  run(process.execPath, ['scripts/bundle.mjs']);
}

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

// 3. Copy the running node binary as the executable base.
copyFileSync(process.execPath, binPath);

// 3b. macOS: postject can't inject into a universal (fat) Mach-O, which is how
// the official node binary ships. Thin it to the host architecture first.
if (isMac) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  try {
    const archs = execFileSync('lipo', ['-archs', binPath], { encoding: 'utf8' }).trim();
    if (archs.split(/\s+/).length > 1) {
      run('lipo', ['-thin', arch, binPath, '-output', binPath]);
    }
  } catch {
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
const fuse = detectFuse(binPath);
const postject = path.join('node_modules', '.bin', isWin ? 'postject.cmd' : 'postject');
const postjectArgs = [binPath, 'NODE_SEA_BLOB', 'dist/sea-prep.blob', '--sentinel-fuse', fuse];
if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(postject, postjectArgs);

// 6. macOS: ad-hoc re-sign so Gatekeeper will run it.
if (isMac) {
  try {
    run('codesign', ['--sign', '-', binPath]);
  } catch {
    /* fine */
  }
}

if (!isWin) chmodSync(binPath, 0o755);
console.log(`built ${binPath} for ${process.platform}/${process.arch}`);
