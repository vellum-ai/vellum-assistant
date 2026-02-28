/**
 * Minimal error classes used by the Twitter skill.
 * Inlined from assistant/src/util/errors.ts (stripped of base-class dependencies).
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ProviderError extends Error {
  public readonly provider: string;
  public readonly statusCode?: number;
  constructor(message: string, provider: string, statusCode?: number) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}
