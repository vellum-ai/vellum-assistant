import { OpenAIProvider } from '../openai/client.js';

export interface OllamaProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

export class OllamaProvider extends OpenAIProvider {
  constructor(model: string, options: OllamaProviderOptions = {}) {
    super(options.apiKey ?? 'ollama', model, {
      baseURL: resolveBaseUrl(options.baseURL),
      providerName: 'ollama',
      providerLabel: 'Ollama',
    });
  }
}

function resolveBaseUrl(optionBaseUrl?: string): string {
  for (const candidate of [optionBaseUrl, process.env.OLLAMA_BASE_URL]) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return DEFAULT_OLLAMA_BASE_URL;
}
