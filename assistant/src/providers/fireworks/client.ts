import { OpenAIProvider } from '../openai/client.js';

export interface FireworksProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

const DEFAULT_FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

export class FireworksProvider extends OpenAIProvider {
  constructor(apiKey: string, model: string, options: FireworksProviderOptions = {}) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_FIREWORKS_BASE_URL,
      providerName: 'fireworks',
      providerLabel: 'Fireworks',
    });
  }
}
