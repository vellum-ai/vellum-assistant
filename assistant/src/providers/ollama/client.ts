import { OpenAIProvider } from '../openai/client.js';

export interface OllamaProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

export class OllamaProvider extends OpenAIProvider {
  constructor(model: string, options: OllamaProviderOptions = {}) {
    super(options.apiKey ?? 'ollama', model, {
      baseURL: options.baseURL ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
      providerName: 'ollama',
      providerLabel: 'Ollama',
    });
  }
}
