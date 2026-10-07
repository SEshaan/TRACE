/**
 * api/endpoints.js
 * ---------------------------------------------------------------------------
 * Every backend path in one table. Nothing else in the app hardcodes a URL.
 * ---------------------------------------------------------------------------
 */

export const EP = {
  health: { method: 'GET', path: '/health' },

  createSession: { method: 'POST', path: '/queries' },
  getSession: (id) => ({ method: 'GET', path: `/queries/${id}` }),
  nextAction: (id) => ({ method: 'POST', path: `/queries/${id}/next-action` }),
  applyAction: (id) => ({ method: 'POST', path: `/queries/${id}/actions` }),
  step: (id) => ({ method: 'POST', path: `/queries/${id}/step` }),
  checkpoint: (id) => ({ method: 'POST', path: `/queries/${id}/checkpoints` }),
  recover: (id) => ({ method: 'POST', path: `/queries/${id}/recover` }),
  finish: (id) => ({ method: 'POST', path: `/queries/${id}/finish` }),
  trace: (id) => ({ method: 'GET', path: `/queries/${id}/trace` }),
  listSessions: { method: 'GET', path: '/queries' },
  schema: { method: 'GET', path: '/queries/schema' },

  agentStatus: { method: 'GET', path: '/queries/agent/status' },
  agentSelect: { method: 'POST', path: '/queries/agent/select' },
};
