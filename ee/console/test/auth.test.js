// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, authenticateToken, resolveRole, AuthError } from '../server/auth.js';
import { withFakeRelata } from './fake-relata.js';

function reqWith(header) {
  return { headers: header ? { authorization: header } : {} };
}

test('extractBearerToken parses "Bearer <token>", case-insensitively, and null for anything else', () => {
  assert.equal(extractBearerToken(reqWith('Bearer abc123')), 'abc123');
  assert.equal(extractBearerToken(reqWith('bearer abc123')), 'abc123');
  assert.equal(extractBearerToken(reqWith('Basic abc123')), null);
  assert.equal(extractBearerToken(reqWith(undefined)), null);
});

test('authenticateToken throws 401 for a missing token, without any network call', async () => {
  await assert.rejects(() => authenticateToken({ url: 'http://127.0.0.1:1' }, null), (e) => e instanceof AuthError && e.status === 401);
});

test('authenticateToken succeeds for a token the cortex accepts via POST /query {sql:"SELECT 1"}', async () => {
  await withFakeRelata({}, async ({ url }) => {
    await assert.doesNotReject(() => authenticateToken({ url }, 'member-token'));
  });
});

test('authenticateToken throws 401 for a token the cortex rejects', async () => {
  await withFakeRelata({}, async ({ url }) => {
    await assert.rejects(() => authenticateToken({ url }, 'wrong-token'), (e) => e instanceof AuthError && e.status === 401);
  });
});

test('authenticateToken throws 502 when the cortex is unreachable — nothing else this stateless server could do', async () => {
  await assert.rejects(
    () => authenticateToken({ url: 'http://127.0.0.1:1' }, 'any-token'),
    (e) => e instanceof AuthError && e.status === 502
  );
});

test('resolveRole is "member" when no principal is discoverable — the common bearer-mode case fails closed, never open', async () => {
  await withFakeRelata({ tokensSelf: () => ({ present: false }) }, async ({ url }) => {
    const { role, principal } = await resolveRole({ url, admins: ['alice'] }, 'member-token');
    assert.equal(role, 'member');
    assert.equal(principal, null);
  });
});

test('resolveRole is "member" when a principal IS discoverable but is not in config.admins', async () => {
  await withFakeRelata({ tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'mallory' } : { present: false }) }, async ({ url }) => {
    const { role, principal } = await resolveRole({ url, admins: ['alice'] }, 'member-token');
    assert.equal(role, 'member');
    assert.equal(principal, 'mallory');
  });
});

test('resolveRole is "admin" only when the discovered principal is listed in config.admins', async () => {
  await withFakeRelata({ tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) }, async ({ url }) => {
    const { role, principal } = await resolveRole({ url, admins: ['alice'] }, 'admin-token');
    assert.equal(role, 'admin');
    assert.equal(principal, 'alice');
  });
});

test('resolveRole never throws — a /tokens/self probe error degrades to "member", not a crash', async () => {
  await assert.doesNotReject(async () => {
    const result = await resolveRole({ url: 'http://127.0.0.1:1', admins: ['alice'] }, 'any-token');
    assert.equal(result.role, 'member');
  });
});
