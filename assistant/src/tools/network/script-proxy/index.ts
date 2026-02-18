export type {
  ProxySessionId,
  ProxySession,
  ProxySessionConfig,
  ProxySessionStatus,
  ProxyEnvVars,
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
