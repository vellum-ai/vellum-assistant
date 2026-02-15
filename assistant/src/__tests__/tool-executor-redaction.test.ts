import { describe, test, expect } from 'bun:test';
import { redactSensitiveFields } from '../security/redaction.js';

describe('redactSensitiveFields', () => {
  test('redacts known sensitive keys', () => {
    const input = {
      service: 'github',
      field: 'token',
      value: 'v1',
      password: 'p1',
      api_key: 'k1',
      authorization: 'a1',
    };
    const result = redactSensitiveFields(input);
    expect(result.service).toBe('github');
    expect(result.field).toBe('token');
    expect(result.value).toBe('<redacted />');
    expect(result.password).toBe('<redacted />');
    expect(result.api_key).toBe('<redacted />');
    expect(result.authorization).toBe('<redacted />');
  });

  test('is case-insensitive for key matching', () => {
    const input = { Password: 'p1', API_KEY: 'k1', Token: 't1' };
    const result = redactSensitiveFields(input);
    expect(result.Password).toBe('<redacted />');
    expect(result.API_KEY).toBe('<redacted />');
    expect(result.Token).toBe('<redacted />');
  });

  test('recurses into nested objects', () => {
    const input = {
      name: 'test',
      config: {
        secret: 'nested',
        endpoint: 'https://api.example.com',
      },
    };
    const result = redactSensitiveFields(input);
    expect(result.name).toBe('test');
    const config = result.config as Record<string, unknown>;
    expect(config.secret).toBe('<redacted />');
    expect(config.endpoint).toBe('https://api.example.com');
  });

  test('recurses into arrays of objects', () => {
    const input = {
      items: [
        { name: 'a', password: 'pa' },
        { name: 'b', password: 'pb' },
      ],
    };
    const result = redactSensitiveFields(input);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0].name).toBe('a');
    expect(items[0].password).toBe('<redacted />');
    expect(items[1].name).toBe('b');
    expect(items[1].password).toBe('<redacted />');
  });

  test('preserves primitive arrays', () => {
    const input = { tags: ['public', 'v1'], token: 'tk' };
    const result = redactSensitiveFields(input);
    expect(result.tags).toEqual(['public', 'v1']);
    expect(result.token).toBe('<redacted />');
  });

  test('does not mutate the original input', () => {
    const input = { value: 'x1', nested: { password: 'y1' } };
    const result = redactSensitiveFields(input);
    expect(input.value).toBe('x1');
    expect((input.nested as Record<string, unknown>).password).toBe('y1');
    expect(result.value).toBe('<redacted />');
  });

  test('handles null and undefined values gracefully', () => {
    const input = { value: null, password: undefined, name: 'test' };
    const result = redactSensitiveFields(input);
    expect(result.value).toBeNull();
    expect(result.password).toBeUndefined();
    expect(result.name).toBe('test');
  });

  test('handles empty objects', () => {
    const result = redactSensitiveFields({});
    expect(result).toEqual({});
  });

  test('redacts numeric and boolean sensitive values', () => {
    const input = { token: 12345, secret: true, name: 'test' };
    const result = redactSensitiveFields(input);
    expect(result.token).toBe('<redacted />');
    expect(result.secret).toBe('<redacted />');
    expect(result.name).toBe('test');
  });

  test('preserves non-sensitive keys completely', () => {
    const input = {
      service: 'gmail',
      field: 'password',
      action: 'store',
      selector: 'input[type=password]',
    };
    const result = redactSensitiveFields(input);
    expect(result).toEqual(input);
  });

  test('redacts credentials and apikey variants', () => {
    const input = { credentials: 'c1', apikey: 'k1' };
    const result = redactSensitiveFields(input);
    expect(result.credentials).toBe('<redacted />');
    expect(result.apikey).toBe('<redacted />');
  });
});
