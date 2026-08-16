// SPDX-License-Identifier: AGPL-3.0-only
import { createRouter } from './router.js';
import { getDeploymentHealth, getDeploymentHealthDetail } from './routes/health.js';
import { getBoard } from './routes/board.js';
import { getAudit, getAuditWhy } from './routes/audit.js';
import { getKnowledge, getKnowledgeDocuments, getProcedures, postPropose, postApprove, postPublish, postReject } from './routes/knowledge.js';
import { getEquipScope, putEquipScope } from './routes/equip.js';
import { listTokens, createToken, revokeToken, postRotateSelf } from './routes/tokens.js';
import { getMembers } from './routes/members.js';

/**
 * The complete route table (G8.1's own "Routes ... consumed by G8.2-G8.7" bullet) — every screen's backend in
 * one place, each line naming its own authz requirement explicitly rather than leaving it to be inferred from
 * the handler. `role: 'admin'` routes are exactly the ones G8.8's curl-bypass suite targets.
 */
export function buildApp() {
  const router = createRouter();

  router.route('GET', '/api/health', 'public', getDeploymentHealth);
  router.route('GET', '/api/health/detail', 'member', getDeploymentHealthDetail);

  router.route('GET', '/api/board', 'member', getBoard);

  router.route('GET', '/api/audit', 'member', getAudit);
  router.route('GET', '/api/audit/why', 'member', getAuditWhy);

  router.route('GET', '/api/knowledge', 'member', getKnowledge);
  router.route('GET', '/api/knowledge/documents', 'member', getKnowledgeDocuments);
  router.route('GET', '/api/procedures', 'member', getProcedures);
  router.route('POST', '/api/knowledge/:contentHash/propose', 'member', postPropose);
  router.route('POST', '/api/knowledge/:contentHash/approve', 'admin', postApprove);
  router.route('POST', '/api/knowledge/:contentHash/publish', 'member', postPublish);
  router.route('POST', '/api/knowledge/:contentHash/reject', 'admin', postReject);

  router.route('GET', '/api/equip/:fleet/:agent', 'member', getEquipScope);
  router.route('PUT', '/api/equip/:fleet/:agent', 'admin', putEquipScope);

  router.route('GET', '/api/tokens', 'admin', listTokens);
  router.route('POST', '/api/tokens', 'admin', createToken);
  router.route('DELETE', '/api/tokens/:id', 'admin', revokeToken);
  router.route('POST', '/api/tokens/self/rotate', 'member', postRotateSelf);

  router.route('GET', '/api/members', 'member', getMembers);

  return router;
}
