import { getConfig } from '../config/loader.js';
import { getSecureKey } from '../security/secure-keys.js';
import { ConfigError } from '../util/errors.js';

export interface ElevenLabsConfig {
  apiKey: string;
  apiBaseUrl: string;
  agentId: string;
  registerCallTimeoutMs: number;
}

export function getElevenLabsConfig(): ElevenLabsConfig {
  const config = getConfig();
  const voice = config.calls.voice;

  const apiKey = getSecureKey('credential:elevenlabs:api_key') ?? '';
  if (!apiKey) {
    throw new ConfigError('ElevenLabs API key is not configured. Set credential:elevenlabs:api_key in the secure key store.');
  }

  const agentId = voice.elevenlabs.agentId;
  if (!agentId) {
    throw new ConfigError('ElevenLabs agent ID is not configured. Set calls.voice.elevenlabs.agentId in config.');
  }

  return {
    apiKey,
    apiBaseUrl: voice.elevenlabs.apiBaseUrl,
    agentId,
    registerCallTimeoutMs: voice.elevenlabs.registerCallTimeoutMs,
  };
}
