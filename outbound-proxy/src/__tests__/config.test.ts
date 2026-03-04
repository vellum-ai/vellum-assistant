import { describe, expect, it } from 'bun:test';

import { ConfigError, loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('returns sensible defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 8080,
      host: '0.0.0.0',
      healthPort: 8081,
      caDir: null,
      logLevel: 'info',
    });
  });

  it('reads PROXY_PORT from the environment', () => {
    const config = loadConfig({ PROXY_PORT: '9090' });
    expect(config.port).toBe(9090);
  });

  it('reads PROXY_HOST from the environment', () => {
    const config = loadConfig({ PROXY_HOST: '127.0.0.1' });
    expect(config.host).toBe('127.0.0.1');
  });

  it('reads PROXY_CA_DIR from the environment', () => {
    const config = loadConfig({ PROXY_CA_DIR: '/tmp/ca' });
    expect(config.caDir).toBe('/tmp/ca');
  });

  it('reads PROXY_LOG_LEVEL from the environment', () => {
    const config = loadConfig({ PROXY_LOG_LEVEL: 'debug' });
    expect(config.logLevel).toBe('debug');
  });

  it('is case-insensitive for log level', () => {
    const config = loadConfig({ PROXY_LOG_LEVEL: 'WARN' });
    expect(config.logLevel).toBe('warn');
  });

  it('throws ConfigError for non-integer port', () => {
    expect(() => loadConfig({ PROXY_PORT: 'abc' })).toThrow(ConfigError);
  });

  it('throws ConfigError for port out of range (0)', () => {
    expect(() => loadConfig({ PROXY_PORT: '0' })).toThrow(ConfigError);
  });

  it('throws ConfigError for port out of range (65536)', () => {
    expect(() => loadConfig({ PROXY_PORT: '65536' })).toThrow(ConfigError);
  });

  it('throws ConfigError for floating-point port', () => {
    expect(() => loadConfig({ PROXY_PORT: '80.5' })).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid log level', () => {
    expect(() => loadConfig({ PROXY_LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('accepts all valid log levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const config = loadConfig({ PROXY_LOG_LEVEL: level });
      expect(config.logLevel).toBe(level);
    }
  });

  it('treats empty strings the same as missing', () => {
    const config = loadConfig({ PROXY_PORT: '', PROXY_LOG_LEVEL: '' });
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('info');
  });

  it('accepts port 1 (minimum)', () => {
    const config = loadConfig({ PROXY_PORT: '1' });
    expect(config.port).toBe(1);
  });

  it('accepts port 65535 (maximum)', () => {
    const config = loadConfig({ PROXY_PORT: '65535' });
    expect(config.port).toBe(65535);
  });

  it('reads PROXY_HEALTH_PORT from the environment', () => {
    const config = loadConfig({ PROXY_HEALTH_PORT: '9091' });
    expect(config.healthPort).toBe(9091);
  });

  it('defaults PROXY_HEALTH_PORT to 8081', () => {
    const config = loadConfig({});
    expect(config.healthPort).toBe(8081);
  });

  it('throws ConfigError for invalid PROXY_HEALTH_PORT', () => {
    expect(() => loadConfig({ PROXY_HEALTH_PORT: 'bad' })).toThrow(ConfigError);
  });

  it('throws ConfigError for out-of-range PROXY_HEALTH_PORT', () => {
    expect(() => loadConfig({ PROXY_HEALTH_PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ PROXY_HEALTH_PORT: '70000' })).toThrow(ConfigError);
  });

  it('treats empty PROXY_HEALTH_PORT the same as missing', () => {
    const config = loadConfig({ PROXY_HEALTH_PORT: '' });
    expect(config.healthPort).toBe(8081);
  });
});
