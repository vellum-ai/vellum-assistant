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
  getSessionsForConversation,
  stopAllSessions,
} from './session-manager.js';

export {
  ensureLocalCA,
  issueLeafCert,
  getCAPath,
} from './certs.js';
