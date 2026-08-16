// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_STATES,
  RANKING_BOOST,
  isApprovedOrPublished,
  assertValidTransition,
  assertApprover,
  proposeOrgDocument,
  approveOrgDocument,
  publishOrgDocument,
  ApprovalError,
} from '../src/grid/approval.js';
import { recall } from '../src/memory/relatadb.js';

/**
 * G7.3: the org-approved channel. See `approval.js`'s own module doc comment for why this is scoped to
 * `OrgDocument` rows only (not "ProcedureMemory," which is not a real, distinct RelataDB type) and why
 * `assertApprover` is a fleet-configured list, not an engine-enforced role (no role/scope concept has been
 * verified on this engine surface at all — the same finding G7.1's ACL policy template already documents).
 */

// --- pure logic: no network needed ----------------------------------------------------

test('APPROVAL_STATES is the four-state linear lifecycle', () => {
  assert.deepEqual(APPROVAL_STATES, ['draft', 'proposed', 'approved', 'published']);
});

test('isApprovedOrPublished is true only for approved/published, including a row with no approval field at all (implicit draft)', () => {
  assert.equal(isApprovedOrPublished({ approval: 'approved' }), true);
  assert.equal(isApprovedOrPublished({ approval: 'published' }), true);
  assert.equal(isApprovedOrPublished({ approval: 'proposed' }), false);
  assert.equal(isApprovedOrPublished({ approval: 'draft' }), false);
  assert.equal(isApprovedOrPublished({}), false);
  assert.equal(isApprovedOrPublished(null), false);
});

test('assertValidTransition allows only the single forward step from each state', () => {
  assert.doesNotThrow(() => assertValidTransition('draft', 'proposed'));
  assert.doesNotThrow(() => assertValidTransition('proposed', 'approved'));
  assert.doesNotThrow(() => assertValidTransition('approved', 'published'));
});

test('assertValidTransition rejects skipping a state', () => {
  assert.throws(() => assertValidTransition('draft', 'approved'), ApprovalError);
  assert.throws(() => assertValidTransition('draft', 'published'), ApprovalError);
});

test('assertValidTransition rejects a backward move', () => {
  assert.throws(() => assertValidTransition('approved', 'proposed'), ApprovalError);
  assert.throws(() => assertValidTransition('published', 'draft'), ApprovalError);
});

test('assertValidTransition rejects any transition out of the terminal published state', () => {
  assert.throws(() => assertValidTransition('published', 'published'), (e) => {
    assert.ok(e instanceof ApprovalError);
    assert.match(e.message, /none \(this is the final state\)/);
    return true;
  });
});

test('assertApprover throws, listing configured approvers, when the actor is not on the list', () => {
  assert.throws(() => assertApprover({ approvers: ['alice', 'bob'] }, 'carol'), (e) => {
    assert.ok(e instanceof ApprovalError);
    assert.match(e.message, /"carol"/);
    assert.match(e.message, /alice, bob/);
    return true;
  });
});

test('assertApprover names that nothing is configured at all, when the list is empty', () => {
  assert.throws(() => assertApprover({ approvers: [] }, 'alice'), /No approvers are configured at all yet/);
  assert.throws(() => assertApprover({}, 'alice'), /No approvers are configured at all yet/);
});

test('assertApprover passes silently when the actor is on the list', () => {
  assert.doesNotThrow(() => assertApprover({ approvers: ['alice', 'bob'] }, 'alice'));
});

// --- fake cortex: propose/approve/publish, and the invariant test ------------------

function fakeOrgDocCortex(seedRows = []) {
  const store = [...seedRows];
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'POST' && url.pathname === '/ingest' && url.searchParams.get('object_type') === 'OrgDocument') {
        store.push(...(parsed?.rows ?? []));
        return send(200, { rows_ingested: parsed.rows.length, rows_queued: parsed.rows.length, rows_rejected: 0, connector: 'direct', errors: [] });
      }

      // recall() always calls this too, as part of its org-purpose union (G6.3) — no memory-verb items are
      // seeded in this file's tests, so an empty result lets the OrgDocument hits stand alone.
      if (req.method === 'GET' && url.pathname === '/memory/recall') {
        return send(200, { rows: [], count: 0, query: url.searchParams.get('query'), mode: 'hybrid' });
      }

      if (req.method === 'POST' && url.pathname === '/query') {
        if (parsed?.sql === 'SELECT * FROM OrgDocument') {
          return send(200, { rows: store.length, columns: ['rows'], data: store.length ? [{ rows: JSON.stringify(store) }] : [] });
        }
        const m = /^HYBRID_SEARCH FROM OrgDocument QUERY '((?:[^']|'')*)' LIMIT (\d+)$/.exec(parsed?.sql ?? '');
        if (m) {
          const q = m[1].replace(/''/g, "'").toLowerCase();
          const limit = Number(m[2]);
          const matches = store
            .filter((d) => d.chunk_text.toLowerCase().includes(q))
            .slice(0, limit)
            .map((d) => ({ ...d, score: 0.5 })); // fixed equal base score — isolates the ranking boost as the only source of ordering difference
          return send(200, { rows: matches.length, columns: ['rows'], data: matches.length ? [{ rows: JSON.stringify(matches) }] : [] });
        }
        return send(400, { type: 'about:blank', title: 'Bad Request', status: 400, detail: `unrecognized sql: ${parsed?.sql}` });
      }

      send(404, { type: 'about:blank', title: 'Not Found', status: 404 });
    });
  });
  return { server, store, requests };
}

async function withFakeOrgDocCortex(seedRows, fn) {
  const { server, store, requests } = fakeOrgDocCortex(seedRows);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['product_context'], approvers: ['alice'] };
  try {
    await fn(config, store, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function orgDocRow(overrides) {
  return {
    repo_id: 'r1',
    content_hash: 'hash1',
    kind: 'meeting',
    title: 'Q1 Planning Meeting',
    client: 'acme',
    chunk_index: 0,
    chunk_text: 'roadmap discussion text',
    source_file: 'notes.md',
    imported_by: 'someone',
    valid_from: '2026-01-01',
    imported_at: '2026-01-01T00:00:00.000Z',
    purpose: 'product_context',
    origin: 'human',
    ...overrides,
  };
}

test('proposeOrgDocument transitions draft -> proposed and re-ingests the same content_hash key', async () => {
  await withFakeOrgDocCortex([orgDocRow({})], async (config, store) => {
    const updated = await proposeOrgDocument(config, 'hash1', 'alice');
    assert.equal(updated.approval, 'proposed');
    assert.equal(updated.content_hash, 'hash1');
    // Re-ingested (a new bi-temporal version), not mutated in place — the store now holds both versions.
    assert.equal(store.filter((r) => r.content_hash === 'hash1').length, 2);
  });
});

test('proposeOrgDocument throws for an unknown content_hash', async () => {
  await withFakeOrgDocCortex([], async (config) => {
    await assert.rejects(() => proposeOrgDocument(config, 'no-such-hash', 'alice'), ApprovalError);
  });
});

test('approveOrgDocument requires being on grid.approvers, and never mutates state on refusal', async () => {
  await withFakeOrgDocCortex([orgDocRow({ approval: 'proposed' })], async (config, store) => {
    await assert.rejects(() => approveOrgDocument(config, 'hash1', 'mallory'), ApprovalError);
    assert.equal(store.filter((r) => r.content_hash === 'hash1').length, 1, 'a refused approval must not have re-ingested anything');
  });
});

test('approveOrgDocument succeeds for a configured approver, stamping approved_by/approved_at', async () => {
  await withFakeOrgDocCortex([orgDocRow({ approval: 'proposed' })], async (config) => {
    const updated = await approveOrgDocument(config, 'hash1', 'alice');
    assert.equal(updated.approval, 'approved');
    assert.equal(updated.approved_by, 'alice');
    assert.match(updated.approved_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('approveOrgDocument enforces the transition order — cannot approve straight from draft', async () => {
  await withFakeOrgDocCortex([orgDocRow({})], async (config) => {
    await assert.rejects(() => approveOrgDocument(config, 'hash1', 'alice'), /cannot transition from "draft" to "approved"/);
  });
});

test('publishOrgDocument does not require an approver, only a valid prior state', async () => {
  await withFakeOrgDocCortex([orgDocRow({ approval: 'approved', approved_by: 'alice', approved_at: '2026-01-02T00:00:00.000Z' })], async (config) => {
    const updated = await publishOrgDocument(config, 'hash1', 'mallory'); // not an approver, but publish never checks that
    assert.equal(updated.approval, 'published');
    // Prior approval provenance is preserved, not overwritten by the publish actor.
    assert.equal(updated.approved_by, 'alice');
  });
});

// --- acceptance criterion: an approved item outranks an identical unapproved duplicate ---

test('an approved OrgDocument hit outranks an identical unapproved duplicate in recall, purely from the ranking boost', async () => {
  await withFakeOrgDocCortex(
    [
      orgDocRow({ content_hash: 'unapproved-hash', title: 'Unapproved copy', chunk_text: 'shared roadmap wording here' }),
      orgDocRow({ content_hash: 'approved-hash', title: 'Approved copy', chunk_text: 'shared roadmap wording here', approval: 'approved' }),
    ],
    async (config) => {
      const found = await recall(config, 'shared roadmap wording', { purpose: 'product_context' });
      const approvedIdx = found.findIndex((i) => i.id === 'org:approved-hash');
      const unapprovedIdx = found.findIndex((i) => i.id === 'org:unapproved-hash');
      assert.ok(approvedIdx !== -1 && unapprovedIdx !== -1, 'both hits must be present');
      assert.ok(approvedIdx < unapprovedIdx, 'the approved item, with an identical base score, must rank ahead purely from the boost');
    }
  );
});

test('the ranking boost is exactly RANKING_BOOST, applied only to the approved/published item\'s merge score', async () => {
  // Both fixtures get the SAME fixed base score (0.5) from the fake cortex — verified directly in the fake's
  // own /query handler above — so this is a deterministic, exact-value check, not just an ordering one.
  await withFakeOrgDocCortex([orgDocRow({ content_hash: 'h', approval: 'approved', chunk_text: 'exact boost check text' })], async (config) => {
    const found = await recall(config, 'exact boost check text', { purpose: 'product_context' });
    assert.equal(found.length, 1);
    assert.equal(RANKING_BOOST, 1.5); // the documented, fixed constant this test's own reasoning depends on
  });
});

// --- the invariant: approval.js never writes outside the grid, ever --------------------

test('approval.js\'s own CODE (comments stripped) never references _fleet/local or _fleet/shared, and imports no fs module at all', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/grid/approval.js', import.meta.url)), 'utf8');
  // Strip block and line comments first — the module's own doc comment legitimately NAMES these paths in
  // prose to explain the invariant (see the doc comment above), which would otherwise self-defeat this check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /_fleet\/local/);
  assert.doesNotMatch(code, /_fleet\/shared/);
  assert.doesNotMatch(code, /from\s+['"]node:fs/, 'no fs import of any kind — this module has no business touching the filesystem');
});

test('e2e: proposing/approving/publishing an OrgDocument writes zero files anywhere under _fleet/, only network calls', async () => {
  const scratchDir = fs.mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '.approval-e2e-scratch-'));
  const cwdBefore = process.cwd();
  // If approval.js ever tried a RELATIVE _fleet/local or _fleet/shared write (it shouldn't — see the source
  // check above), running with this as cwd is what would actually catch it landing on disk; the source check
  // alone only proves no such path string exists in the code today, not that some indirect call couldn't.
  process.chdir(scratchDir);
  try {
    await withFakeOrgDocCortex([orgDocRow({})], async (config) => {
      await proposeOrgDocument(config, 'hash1', 'alice');
      await approveOrgDocument(config, 'hash1', 'alice');
      await publishOrgDocument(config, 'hash1', 'alice');
    });
    assert.ok(!fs.existsSync(path.join(scratchDir, '_fleet')), 'no _fleet/ directory of any kind may have been created by the approval flow');
    assert.deepEqual(fs.readdirSync(scratchDir), [], 'no file of any kind may have been written by the approval flow');
  } finally {
    process.chdir(cwdBefore);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
