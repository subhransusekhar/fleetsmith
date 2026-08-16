// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolvePrincipal, assertPushIdentity, rotateToken, aclPolicyStatus, ACL_POLICY, IdentityError } from '../src/grid/identity.js';

/**
 * G7.1: identity. See `identity.js`'s own module doc comment for why there is no server-side ACL test here —
 * no such endpoint exists on this engine yet (a known, tracked upstream gap, not a testing limitation), so
 * `aclPolicyStatus()` is tested as the honest, always-`applied: false` template report it actually is.
 */

function fakeTokensServer({ present = false, principal = null, rotateResponse = { token: 'new-token-value' } } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, pathname: url.pathname });
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && url.pathname === '/tokens/self') {
      return send(200, present ? { present: true, principal } : { present: false });
    }
    if (req.method === 'POST' && url.pathname === '/tokens/self/rotate') {
      return send(200, rotateResponse);
    }
    send(404, { type: 'about:blank', title: 'Not Found', status: 404 });
  });
  return { server, requests };
}

async function withFakeTokensServer(opts, fn) {
  const { server, requests } = fakeTokensServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token' };
  try {
    await fn(config, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- resolvePrincipal ----------------------------------------------------------------

test('resolvePrincipal returns null when the engine reports present:false (the common bearer-mode case)', async () => {
  await withFakeTokensServer({ present: false }, async (config) => {
    assert.equal(await resolvePrincipal(config), null);
  });
});

test('resolvePrincipal returns the principal when the engine reports present:true', async () => {
  await withFakeTokensServer({ present: true, principal: 'alice' }, async (config) => {
    assert.equal(await resolvePrincipal(config), 'alice');
  });
});

// --- assertPushIdentity ---------------------------------------------------------------

test('assertPushIdentity never throws, and reports enforced:false, when no principal is discoverable', async () => {
  await withFakeTokensServer({ present: false }, async (config) => {
    const result = await assertPushIdentity(config, 'alice');
    assert.equal(result.enforced, false);
    assert.equal(result.principal, null);
    assert.match(result.note, /nothing to compare/);
  });
});

test('assertPushIdentity returns enforced:true and no note when the principal matches the actor', async () => {
  await withFakeTokensServer({ present: true, principal: 'alice' }, async (config) => {
    const result = await assertPushIdentity(config, 'alice');
    assert.equal(result.enforced, true);
    assert.equal(result.principal, 'alice');
    assert.equal(result.note, undefined);
  });
});

test('assertPushIdentity throws IdentityError with an actionable fix when a real principal mismatches the actor', async () => {
  await withFakeTokensServer({ present: true, principal: 'bob' }, async (config) => {
    await assert.rejects(() => assertPushIdentity(config, 'alice'), (e) => {
      assert.ok(e instanceof IdentityError);
      assert.match(e.message, /"bob"/);
      assert.match(e.message, /"alice"/);
      assert.match(e.message, /FLEETSMITH_ACTOR/, 'the error must name the actual fix, not just describe the problem');
      return true;
    });
  });
});

// --- rotateToken -----------------------------------------------------------------------

test('rotateToken calls the real /tokens/self/rotate endpoint and returns the new token', async () => {
  await withFakeTokensServer({ rotateResponse: { token: 'freshly-rotated-token' } }, async (config, requests) => {
    const { token } = await rotateToken(config);
    assert.equal(token, 'freshly-rotated-token');
    assert.ok(requests.some((r) => r.method === 'POST' && r.pathname === '/tokens/self/rotate'));
  });
});

test('rotateToken recognizes a few plausible response field names, defensively, since the real shape is unverified', async () => {
  await withFakeTokensServer({ rotateResponse: { new_token: 'via-new-token-field' } }, async (config) => {
    assert.equal((await rotateToken(config)).token, 'via-new-token-field');
  });
});

test('rotateToken throws a clear IdentityError when the response has no recognizable token field', async () => {
  await withFakeTokensServer({ rotateResponse: { unexpected_shape: true } }, async (config) => {
    await assert.rejects(() => rotateToken(config), IdentityError);
  });
});

// --- ACL policy template (aspirational — see the module doc comment) -----------------

test('aclPolicyStatus always reports applied:false, regardless of anything about the config', () => {
  const status = aclPolicyStatus();
  assert.equal(status.applied, false);
  assert.match(status.note, /not yet wired/);
  assert.equal(status.policy, ACL_POLICY);
});

test('ACL_POLICY is a real, reviewable template naming both a client-side-only rule and a not-yet-enforceable one', () => {
  assert.equal(ACL_POLICY.version, 1);
  assert.match(ACL_POLICY.status, /aspirational/);
  const ruleIds = ACL_POLICY.rules.map((r) => r.id);
  assert.ok(ruleIds.includes('writer-actor-must-equal-principal'));
  assert.ok(ruleIds.includes('org-approval-requires-approver-role'));
  for (const rule of ACL_POLICY.rules) {
    assert.ok(Array.isArray(rule.applies_to) && rule.applies_to.length > 0);
    assert.ok(typeof rule.enforced_by === 'string' && rule.enforced_by.length > 0);
  }
});

// --- live verification ----------------------------------------------------------------

/**
 * Deliberately no live test for `rotateToken` itself: rotation is destructive against a REAL instance — it
 * invalidates whatever token was previously live, which would silently break every other live test in this
 * suite relying on that same `RELATA_TEST_TOKEN`, and could break a real developer's own working setup if
 * they happened to have `RELATA_TEST_URL`/`RELATA_TEST_TOKEN` exported when running `node --test`. Every
 * other live test in this milestone is read-only or purely additive (a fresh per-pid type name, an isolated
 * `repo_id`) — none invalidates an existing credential. `resolvePrincipal`/`assertPushIdentity` (read-only:
 * `GET /tokens/self`) are exercised live indirectly via `init.test.js`'s own `gridInit` live test.
 */
