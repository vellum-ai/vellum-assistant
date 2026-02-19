export type {
  ProxySessionId,
  ProxySession,
  ProxySessionConfig,
  ProxySessionStatus,
  ProxyEnvVars,
  ProxyApprovalRequest,
  ProxyApprovalCallback,
} from './types.js';

export {
  createSession,
  startSession,
  stopSession,
  getSessionEnv,
  getActiveSession,
  getOrStartSession,
  getSessionsForConversation,
  stopAllSessions,
} from './session-manager.js';

export {
  ensureLocalCA,
  ensureCombinedCABundle,
  issueLeafCert,
  getCAPath,
  getCombinedCAPath,
} from './certs.js';
