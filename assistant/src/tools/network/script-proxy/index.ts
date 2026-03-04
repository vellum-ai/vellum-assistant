export {
  ensureCombinedCABundle,
  ensureLocalCA,
  getCAPath,
  getCombinedCAPath,
  issueLeafCert,
} from "./certs.js";
export {
  createSession,
  getActiveSession,
  getOrStartSession,
  getSessionEnv,
  getSessionsForConversation,
  startSession,
  stopAllSessions,
  stopSession,
} from "./session-manager.js";
export type {
  PolicyDecision,
  ProxyApprovalCallback,
  ProxyApprovalRequest,
  ProxyEnvVars,
  ProxySession,
  ProxySessionConfig,
  ProxySessionId,
  ProxySessionStatus,
} from "@vellumai/outbound-proxy";
