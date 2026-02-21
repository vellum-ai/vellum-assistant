import { getConfig } from '../config/loader.js';
import { getSecureKey } from '../security/secure-keys.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('elevenlabs-config');

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
    log.warn('No ElevenLabs API key found in secure key store (credential:elevenlabs:api_key)');
  }

  return {
    apiKey,
    apiBaseUrl: voice.elevenlabs.apiBaseUrl,
    agentId: voice.elevenlabs.agentId,
    registerCallTimeoutMs: voice.elevenlabs.registerCallTimeoutMs,
  };
}
