// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RelataDB grid config resolution (v0.7.0 G1.1).
 *
 * Absence is the normal state: no env vars and no `grid:` block in fleet.yaml
 * means `resolveGridConfig` returns `null`, nothing registers through
 * `src/lib/registry.js`, and a fleet build/run is byte-identical to a plain
 * v0.6 checkout with `ee/` deleted. This module only decides WHETHER and
 * WHERE the adapter connects — it never talks to RelataDB itself.
 *
 * Resolution order, env over spec, both explicit:
 *  1. `RELATA_URL` + `RELATA_TOKEN` — set together or not at all. A lone one
 *     of the pair is almost always a mistake (a half-exported env var), and
 *     silently falling through to the spec block would hide that mistake
 *     rather than surface it.
 *  2. `fleet.grid` in the spec (an optional, permissive passthrough at the
 *     core schema layer — this module owns every rule beyond "is an
 *     object"): `url`, `token_env` (the NAME of an env var holding the
 *     token — never the token itself), optional `purposes` and
 *     `accel_endpoint`.
 *
 * A literal token in the spec is refused outright, not merely discouraged:
 * `fleet.yaml` is meant to be committed, and a token that lands there once is
 * a credential leak that persists in git history forever, not a linting
 * problem to fix on the next commit.
 */

export class ConfigError extends Error {}

function assertValidUrl(url, source) {
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`${source} is not a valid URL: "${url}"`);
  }
}

function readEnvPair() {
  const url = process.env.RELATA_URL;
  const token = process.env.RELATA_TOKEN;
  if (!url && !token) return null;
  if (!url) throw new ConfigError('RELATA_TOKEN is set but RELATA_URL is not — set both, or neither, of the env pair.');
  if (!token) throw new ConfigError('RELATA_URL is set but RELATA_TOKEN is not — set both, or neither, of the env pair.');
  assertValidUrl(url, 'RELATA_URL');
  return { url, token, purposes: [], accelEndpoint: process.env.RELATA_ACCEL_ENDPOINT ?? null };
}

function readSpecBlock(spec) {
  const grid = spec?.fleet?.grid;
  if (!grid) return null;

  if ('token' in grid) {
    throw new ConfigError(
      'fleet.grid.token holds a literal token. fleet.yaml is committed to git, so a literal token here is a ' +
        'permanent credential leak. Set fleet.grid.token_env to the NAME of an environment variable instead ' +
        '(e.g. token_env: RELATA_TOKEN), and export the token itself only in the environment.'
    );
  }
  if (!grid.url) throw new ConfigError('fleet.grid.url is required when a grid: block is present.');
  assertValidUrl(grid.url, 'fleet.grid.url');
  if (!grid.token_env) {
    throw new ConfigError('fleet.grid.token_env is required — name the environment variable holding the RelataDB token.');
  }
  const token = process.env[grid.token_env];
  if (!token) {
    throw new ConfigError(`fleet.grid.token_env names "${grid.token_env}", but that environment variable is not set.`);
  }

  const purposes = Array.isArray(grid.purposes) ? grid.purposes.filter((p) => typeof p === 'string') : [];
  return { url: grid.url, token, purposes, accelEndpoint: grid.accel_endpoint ?? null };
}

/**
 * `{ url, token, purposes, accelEndpoint } | null`. `null` means "not
 * configured" — the caller (the adapter's own registration code, landing in
 * G1.2) must not register a memory backend at all in that case, exactly as
 * an absent `ee/` leaves the registry with only the file backend in it.
 */
export function resolveGridConfig(spec) {
  return readEnvPair() ?? readSpecBlock(spec);
}
