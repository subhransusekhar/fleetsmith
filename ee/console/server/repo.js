// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { normalizeRemoteUrl } from '../../src/grid/ontology.js';

/**
 * The console has no git checkout of its own — every route that needs a `repo_id` (the SHA-256 of a
 * normalized git remote URL, `ontology.js`'s `resolveRepoId()`) takes a `?remote=<url>` query param instead
 * and hashes it the same way, reusing the EXACT SAME normalization so a console request and a CLI daemon
 * push for the same repo always agree on one `repo_id` — this is the one place that invariant could silently
 * drift if the hashing were duplicated instead of shared.
 */
export class RepoParamError extends Error {}

export function repoIdFromRemote(remote) {
  if (!remote) {
    throw new RepoParamError('missing required "remote" query param — the console has no git checkout of its own, so every repo-scoped route needs the repo\'s git remote URL to compute the same repo_id the CLI daemon uses.');
  }
  return createHash('sha256').update(normalizeRemoteUrl(remote)).digest('hex');
}
