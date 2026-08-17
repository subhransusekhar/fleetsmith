/**
 * Serve GitHub Release assets from this domain.
 *
 *   /dl/fleetsmith-macos-arm64          -> the latest release's asset
 *   /dl/v0.7.1/fleetsmith-macos-arm64   -> that tag's asset
 *
 * Why a Function and not a CNAME: DNS maps a hostname to a host and carries no
 * path, so it cannot turn `dl.example.com/x` into
 * `github.com/owner/repo/releases/download/tag/x`. A CNAME at GitHub would send
 * GitHub this domain's Host header on `/` and get GitHub's 404. Rewriting the
 * path means re-issuing the request, which means a proxy.
 *
 * Why a Pages Function and not a standalone Worker: this project is already a
 * Pages deployment, so a Function ships with the same `wrangler pages deploy`
 * and needs no second deploy target, no route table entry, and no extra
 * hostname. Pages sends only matching paths here; everything else stays static.
 *
 * THE IMPORTANT PART IS THE ALLOWLIST. A proxy that forwards whatever path it
 * is handed is an open relay: someone else's traffic, and eventually someone
 * else's abuse report, arrives under this domain's reputation. Owner and repo
 * are compiled in, and the tag and asset name are both matched against strict
 * patterns rather than escaped — anything unrecognised is a 400, not a
 * best-effort fetch.
 */

const OWNER = 'subhransusekhar';
const REPO = 'fleetsmith';

/** Exactly the assets the release workflow publishes. Not a wildcard. */
const ASSETS = new Set([
  'fleetsmith-linux-x64',
  'fleetsmith-macos-arm64',
  'fleetsmith-macos-x64',
  'fleetsmith-windows-x64.exe',
]);

/** `latest`, or a plain vX.Y.Z tag. No ranges, no arbitrary refs. */
const TAG = /^v\d+\.\d+\.\d+$/;

function bad(status, message) {
  return new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export async function onRequest({ request, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  // [[path]] gives the segments after /dl/ — one (asset) or two (tag, asset).
  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);

  let tag = 'latest';
  let asset;
  if (segments.length === 1) {
    [asset] = segments;
  } else if (segments.length === 2) {
    [tag, asset] = segments;
  } else {
    return bad(404, 'Usage: /dl/<asset> or /dl/<tag>/<asset>');
  }

  if (tag !== 'latest' && !TAG.test(tag)) {
    return bad(400, `Unrecognised tag "${tag}". Use "latest" or a vX.Y.Z tag.`);
  }
  if (!ASSETS.has(asset)) {
    return bad(404, `Unknown asset "${asset}". Available:\n  ${[...ASSETS].join('\n  ')}`);
  }

  const upstream =
    tag === 'latest'
      ? `https://github.com/${OWNER}/${REPO}/releases/latest/download/${asset}`
      : `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${asset}`;

  // Always GET upstream, even to answer a HEAD.
  //
  // GitHub answers HEAD on `releases/latest/download/…` with a 302, and the
  // runtime's fetch does not follow it for HEAD the way it does for GET — the
  // response arrives still 3xx, which read as an upstream failure and returned
  // 502 while the identical GET streamed fine. Asking for GET and discarding
  // the body is the difference between a HEAD that works and one that lies.
  const res = await fetch(upstream, {
    method: 'GET',
    redirect: 'follow',
    cf: {
      // A release asset for a given tag is immutable, so it is worth caching at
      // the edge. `latest` is NOT immutable — it moves every release — so it
      // gets a short TTL and everything else a long one.
      cacheEverything: true,
      cacheTtl: tag === 'latest' ? 300 : 86400,
    },
  });

  if (!res.ok) {
    // Don't leave the upstream stream dangling on an error path.
    res.body?.cancel().catch(() => {});
    return bad(
      res.status === 404 ? 404 : 502,
      res.status === 404
        ? `No asset "${asset}" on release "${tag}".`
        : `Upstream GitHub returned ${res.status}.`
    );
  }

  const headers = new Headers();
  // Copy only what a download needs. Forwarding GitHub's headers wholesale
  // would also forward its cookies, its CSP and its rate-limit headers.
  for (const h of ['content-type', 'content-length', 'etag', 'last-modified', 'accept-ranges']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('content-type', headers.get('content-type') ?? 'application/octet-stream');
  headers.set('content-disposition', `attachment; filename="${asset}"`);
  headers.set(
    'cache-control',
    tag === 'latest' ? 'public, max-age=300, must-revalidate' : 'public, max-age=86400, immutable'
  );
  headers.set('x-content-type-options', 'nosniff');
  // Which upstream actually served this, so a bad download is diagnosable
  // without guessing whether the edge or GitHub produced it.
  headers.set('x-release-tag', tag);

  if (request.method === 'HEAD') {
    // The upstream GET's body is not wanted; cancelling it stops the transfer
    // instead of letting ~110MB drain in the background for a headers-only
    // request. content-length above still reports the real size.
    res.body?.cancel().catch(() => {});
    return new Response(null, { status: 200, headers });
  }
  return new Response(res.body, { status: 200, headers });
}
