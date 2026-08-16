// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGridConfig, ConfigError } from '../src/config.js';

/**
 * Every env var this module reads, saved and restored around each test.
 * Config resolution is env-sensitive by design, which makes cross-test
 * pollution the single easiest way to write a flaky suite here — a test
 * earlier in file order leaking RELATA_URL into a later one that assumes
 * it is unset would fail confusingly, and only in full-suite runs.
 */
const ENV_KEYS = ['RELATA_URL', 'RELATA_TOKEN', 'RELATA_ACCEL_ENDPOINT', 'MY_TOKEN_VAR'];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

test('no env and no grid block resolves to null — the default, unconfigured state', () => {
  withEnv({}, () => {
    assert.equal(resolveGridConfig({ fleet: {} }), null);
    assert.equal(resolveGridConfig({ fleet: { grid: null } }), null);
    assert.equal(resolveGridConfig(undefined), null);
  });
});

test('env pair resolves when both are set', () => {
  withEnv({ RELATA_URL: 'https://cortex.example.com', RELATA_TOKEN: 'secret-abc' }, () => {
    const cfg = resolveGridConfig({ fleet: {} });
    assert.deepEqual(cfg, {
      url: 'https://cortex.example.com',
      token: 'secret-abc',
      purposes: [],
      accelEndpoint: null,
    });
  });
});

test('env RELATA_ACCEL_ENDPOINT is carried through when the env pair resolves', () => {
  withEnv(
    { RELATA_URL: 'https://cortex.example.com', RELATA_TOKEN: 'secret-abc', RELATA_ACCEL_ENDPOINT: 'https://accel.example.com' },
    () => {
      const cfg = resolveGridConfig({ fleet: {} });
      assert.equal(cfg.accelEndpoint, 'https://accel.example.com');
    }
  );
});

test('a lone half of the env pair is rejected, not silently ignored', () => {
  withEnv({ RELATA_URL: 'https://cortex.example.com' }, () => {
    assert.throws(() => resolveGridConfig({ fleet: {} }), /RELATA_TOKEN is set but RELATA_URL is not|RELATA_URL is set but RELATA_TOKEN is not/);
  });
  withEnv({ RELATA_TOKEN: 'secret-abc' }, () => {
    assert.throws(() => resolveGridConfig({ fleet: {} }), ConfigError);
  });
});

test('env overrides a spec grid: block entirely', () => {
  withEnv({ RELATA_URL: 'https://env.example.com', RELATA_TOKEN: 'env-token', MY_TOKEN_VAR: 'spec-token' }, () => {
    const cfg = resolveGridConfig({
      fleet: { grid: { url: 'https://spec.example.com', token_env: 'MY_TOKEN_VAR' } },
    });
    assert.equal(cfg.url, 'https://env.example.com');
    assert.equal(cfg.token, 'env-token');
  });
});

test('a spec grid: block resolves when no env pair is set', () => {
  withEnv({ MY_TOKEN_VAR: 'spec-token-value' }, () => {
    const cfg = resolveGridConfig({
      fleet: { grid: { url: 'https://spec.example.com', token_env: 'MY_TOKEN_VAR', purposes: ['cross_dev_reuse', 42, 'grid_sync'] } },
    });
    assert.equal(cfg.url, 'https://spec.example.com');
    assert.equal(cfg.token, 'spec-token-value');
    // Non-string entries are dropped rather than crashing on a malformed list.
    assert.deepEqual(cfg.purposes, ['cross_dev_reuse', 'grid_sync']);
  });
});

test('a literal token in the spec is refused with a clear, specific message', () => {
  withEnv({}, () => {
    assert.throws(
      () => resolveGridConfig({ fleet: { grid: { url: 'https://spec.example.com', token: 'literal-secret' } } }),
      /literal token.*token_env/s
    );
  });
});

test('a missing url in the spec block is refused', () => {
  withEnv({ MY_TOKEN_VAR: 'x' }, () => {
    assert.throws(() => resolveGridConfig({ fleet: { grid: { token_env: 'MY_TOKEN_VAR' } } }), /fleet\.grid\.url is required/);
  });
});

test('an invalid url is refused, in both the env and spec paths', () => {
  withEnv({ RELATA_URL: 'not a url', RELATA_TOKEN: 'x' }, () => {
    assert.throws(() => resolveGridConfig({ fleet: {} }), /RELATA_URL is not a valid URL/);
  });
  withEnv({ MY_TOKEN_VAR: 'x' }, () => {
    assert.throws(
      () => resolveGridConfig({ fleet: { grid: { url: 'not a url', token_env: 'MY_TOKEN_VAR' } } }),
      /fleet\.grid\.url is not a valid URL/
    );
  });
});

test('a missing token_env is refused', () => {
  withEnv({}, () => {
    assert.throws(() => resolveGridConfig({ fleet: { grid: { url: 'https://spec.example.com' } } }), /token_env is required/);
  });
});

test('token_env naming an env var that is not actually set is refused, naming the var', () => {
  withEnv({}, () => {
    assert.throws(
      () => resolveGridConfig({ fleet: { grid: { url: 'https://spec.example.com', token_env: 'MY_TOKEN_VAR' } } }),
      /names "MY_TOKEN_VAR", but that environment variable is not set/
    );
  });
});

test('accel_endpoint passes through from the spec block, defaulting to null', () => {
  withEnv({ MY_TOKEN_VAR: 'x' }, () => {
    const withAccel = resolveGridConfig({
      fleet: { grid: { url: 'https://spec.example.com', token_env: 'MY_TOKEN_VAR', accel_endpoint: 'https://accel.example.com' } },
    });
    assert.equal(withAccel.accelEndpoint, 'https://accel.example.com');

    const withoutAccel = resolveGridConfig({
      fleet: { grid: { url: 'https://spec.example.com', token_env: 'MY_TOKEN_VAR' } },
    });
    assert.equal(withoutAccel.accelEndpoint, null);
  });
});
