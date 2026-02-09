import { getDataDir } from '../util/platform.js';
import type { AssistantConfig } from './types.js';

export const DEFAULT_CONFIG: AssistantConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929', // alias: claude-sonnet-4-5
  apiKeys: {},
  maxTokens: 4096,
  dataDir: getDataDir(),
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: false,
  },
};

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant running locally on the user's machine. You have access to tools that let you interact with the computer, filesystem, and terminal. Be concise and helpful.`;
