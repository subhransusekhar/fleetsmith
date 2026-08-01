import { tool } from '@opencode-ai/plugin';
import { buildFleetsmithTools } from './opencode-plugin.js';

/**
 * fleetsmith as an opencode plugin.
 *
 * Exposes the fleetsmith builder in-session as custom tools — `fleet_patterns`,
 * `fleet_validate`, `fleet_build`, `fleet_init`, `fleet_install` — so an
 * opencode agent can scaffold, validate, compile, and install fleets without
 * shelling out to the CLI.
 *
 * This is the ONLY module that imports `@opencode-ai/plugin` (provided by the
 * opencode runtime); the tool logic lives in ./opencode-plugin.js so it stays
 * testable without the peer dependency.
 *
 * Configure it in opencode.json. Options ride along in the tuple form:
 *     { "plugin": [["fleetsmith/opencode", { "autobuild": true }]] }
 * or without options:
 *     { "plugin": ["fleetsmith/opencode"] }
 *
 * Options:
 *   autobuild — recompile the harness whenever a fleet.yaml is edited in-session.
 *               Also settable with FLEETSMITH_OPENCODE_AUTOBUILD=1, which
 *               predates plugin options and still works.
 */
export const Fleetsmith = async (ctx, options) => buildFleetsmithTools(tool, ctx, options);

export default Fleetsmith;
