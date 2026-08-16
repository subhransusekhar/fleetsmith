// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { declaredFiles, declaredSymbols } from '../src/grid/declared.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(repoDir, relPath, content) {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * A real git repo in a temp dir: one base commit (tracked as `refs/remotes/origin/main`, so
 * `declaredFiles`'s own default argument is exercised, not just an explicit baseRef), then a set of
 * modified/untracked working-tree files spanning JS/TS, Python, Go, Rust, an oversize file, a binary file
 * (a `.js` file with a null byte, so it reaches the binary check rather than being skipped for its
 * extension first), and an unsupported-extension file.
 */
function withFixtureRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-declared-test-'));
  try {
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);

    writeFile(dir, 'main.js', 'function baseFunc() {}\n');
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'base'], dir);
    const baseSha = git(['rev-parse', 'HEAD'], dir).trim();
    git(['update-ref', 'refs/remotes/origin/main', baseSha], dir);

    // Modify the tracked file.
    writeFile(dir, 'main.js', 'function baseFunc() {}\n\nexport function ChangedFunc() {}\nconst changedConst = 1;\nclass ChangedClass {}\n');

    // Untracked files across the four recognized language families.
    writeFile(dir, 'script.py', 'def python_func():\n    pass\n\nclass PythonClass:\n    pass\n');
    writeFile(dir, 'main.go', 'package main\n\nfunc GoFunc() {}\n\nfunc (r *Receiver) Method() {}\n');
    writeFile(dir, 'lib.rs', 'fn rust_fn() {}\n');

    // An oversize file (over the 1 MB cap) — content is irrelevant, only size matters.
    writeFile(dir, 'big.js', `function bigFileFunc() {}\n// ${'x'.repeat(1024 * 1024 + 10)}\n`);

    // A binary file with a RECOGNIZED extension, so it reaches the binary check rather than being
    // skipped for an unsupported extension first.
    fs.writeFileSync(path.join(dir, 'weird-binary.js'), Buffer.from([0x66, 0x75, 0x6e, 0x00, 0x63, 0x00, 0x00]));

    // An extension none of the four families claim.
    writeFile(dir, 'notes.txt', 'function notReallyCode() {}\n');

    return fn(dir, baseSha);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- declaredFiles -----------------------------------------------------------

test('declaredFiles unions git diff --name-only against baseRef with untracked files from git status --porcelain', () => {
  withFixtureRepo((dir, baseSha) => {
    const { files, warnings } = declaredFiles(dir, baseSha);
    assert.deepEqual(files, ['big.js', 'lib.rs', 'main.go', 'main.js', 'notes.txt', 'script.py', 'weird-binary.js'].sort());
    assert.deepEqual(warnings, []);
  });
});

test('declaredFiles honors its default baseRef (origin/main) when none is passed', () => {
  withFixtureRepo((dir) => {
    const { files } = declaredFiles(dir);
    assert.ok(files.includes('main.js'));
  });
});

test('declaredFiles never throws on an unreachable baseRef — yields an empty diff half plus a warning', () => {
  withFixtureRepo((dir) => {
    const { files, warnings } = declaredFiles(dir, 'not-a-real-ref-anywhere');
    // git status --porcelain still succeeds independently of the bad ref, so untracked files still show up.
    assert.ok(files.includes('script.py'));
    assert.ok(warnings.some((w) => w.includes('git diff')));
  });
});

test('declaredFiles never throws when repoDir is not a git repository at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-not-a-repo-'));
  try {
    const { files, warnings } = declaredFiles(dir);
    assert.deepEqual(files, []);
    assert.ok(warnings.length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('declaredFiles caps at 200 entries and warns when truncating', () => {
  withFixtureRepo((dir) => {
    for (let i = 0; i < 210; i++) writeFile(dir, `generated/file-${String(i).padStart(4, '0')}.js`, `const x${i} = ${i};\n`);
    const { files, warnings } = declaredFiles(dir);
    assert.equal(files.length, 200);
    assert.ok(warnings.some((w) => w.includes('truncated to 200')));
  });
});

// --- declaredSymbols -----------------------------------------------------------

test('declaredSymbols detects definitions across all four language families', () => {
  withFixtureRepo((dir) => {
    const { files } = declaredFiles(dir);
    const { symbols, warnings } = declaredSymbols(files, dir);
    for (const expected of ['baseFunc', 'ChangedFunc', 'changedConst', 'ChangedClass', 'python_func', 'PythonClass', 'GoFunc', 'Method', 'rust_fn']) {
      assert.ok(symbols.includes(expected), `expected "${expected}" among ${JSON.stringify(symbols)}`);
    }
    assert.ok(!warnings.some((w) => w.includes('truncated to the 200')), 'this fixture has far fewer than 200 symbols');
  });
});

test('declaredSymbols skips an oversize file and warns, without throwing', () => {
  withFixtureRepo((dir) => {
    const { files } = declaredFiles(dir);
    const { symbols, warnings } = declaredSymbols(files, dir);
    assert.ok(!symbols.includes('bigFileFunc'), 'the oversize file must never be regex-scanned');
    assert.ok(warnings.some((w) => w.includes('big.js') && w.includes('exceeds')));
  });
});

test('declaredSymbols skips a binary file (recognized extension, null byte in content) and warns, without throwing', () => {
  withFixtureRepo((dir) => {
    const { files } = declaredFiles(dir);
    const { warnings } = declaredSymbols(files, dir);
    assert.ok(warnings.some((w) => w.includes('weird-binary.js') && w.includes('binary')));
  });
});

test('declaredSymbols silently skips a file whose extension no family claims', () => {
  withFixtureRepo((dir) => {
    const { files } = declaredFiles(dir);
    const { symbols } = declaredSymbols(files, dir);
    assert.ok(!symbols.includes('notReallyCode'), '.txt is not one of the four recognized language families');
  });
});

test('declaredSymbols de-duplicates case-insensitively while preserving first-seen display casing', () => {
  withFixtureRepo((dir, baseSha) => {
    writeFile(dir, 'dup.js', 'function Widget() {}\nconst widget = 1;\n');
    const { symbols } = declaredSymbols(['dup.js'], dir);
    const widgetOccurrences = symbols.filter((s) => s.toLowerCase() === 'widget');
    assert.equal(widgetOccurrences.length, 1, 'Widget and widget should collapse to a single entry');
    assert.equal(widgetOccurrences[0], 'Widget', 'the first-seen display casing wins');
  });
});

test('declaredSymbols never throws when a listed file no longer exists on disk', () => {
  withFixtureRepo((dir) => {
    const { symbols, warnings } = declaredSymbols(['does-not-exist.js'], dir);
    assert.deepEqual(symbols, []);
    assert.deepEqual(warnings, []);
  });
});

test('declaredSymbols caps at 200 symbols across all files combined and warns when truncating', () => {
  withFixtureRepo((dir) => {
    let content = '';
    for (let i = 0; i < 250; i++) content += `function generatedFn${i}() {}\n`;
    writeFile(dir, 'many-symbols.js', content);
    const { symbols, warnings } = declaredSymbols(['many-symbols.js'], dir);
    assert.equal(symbols.length, 200);
    assert.ok(warnings.some((w) => w.includes('truncated to the 200')));
  });
});
