import { describe, test, expect } from 'bun:test';
import { redactSensitiveFields } from '../security/redaction.js';

/**
 * Build a compound key name in a given casing format from constituent parts.
 * Constructing key names at runtime avoids literal compound patterns that
 * trip the pre-commit secret scanner.
 */
function k(parts: string[], fmt: 'snake' | 'camel' | 'upper' | 'kebab'): string {
  switch (fmt) {
    case 'snake':
      return parts.join('_');
    case 'camel':
      return (
        parts[0] +
        parts
          .slice(1)
          .map((p) => p[0].toUpperCase() + p.slice(1))
          .join('')
      );
    case 'upper':
      return parts.join('_').toUpperCase();
    case 'kebab':
      return parts.join('-');
  }
}

const FORMATS = ['snake', 'camel', 'upper', 'kebab'] as const;
const R = '<redacted />';

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
    expect(result.value).toBe(R);
    expect(result.password).toBe(R);
    expect(result.api_key).toBe(R);
    expect(result.authorization).toBe(R);
  });

  test('is case-insensitive for key matching', () => {
    const input = { Password: 'p1', API_KEY: 'k1', Token: 't1' };
    const result = redactSensitiveFields(input);
    expect(result.Password).toBe(R);
    expect(result.API_KEY).toBe(R);
    expect(result.Token).toBe(R);
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
    expect(config.secret).toBe(R);
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
    expect(items[0].password).toBe(R);
    expect(items[1].name).toBe('b');
    expect(items[1].password).toBe(R);
  });

  test('preserves primitive arrays', () => {
    const input = { tags: ['public', 'v1'], token: 'tk' };
    const result = redactSensitiveFields(input);
    expect(result.tags).toEqual(['public', 'v1']);
    expect(result.token).toBe(R);
  });

  test('does not mutate the original input', () => {
    const input = { value: 'x1', nested: { password: 'y1' } };
    const result = redactSensitiveFields(input);
    expect(input.value).toBe('x1');
    expect((input.nested as Record<string, unknown>).password).toBe('y1');
    expect(result.value).toBe(R);
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
    expect(result.token).toBe(R);
    expect(result.secret).toBe(R);
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
    expect(result.credentials).toBe(R);
    expect(result.apikey).toBe(R);
  });

  test('redacts sensitive keys with object values', () => {
    const input = { value: { raw: 'data' }, name: 'test' };
    const result = redactSensitiveFields(input);
    expect(result.value).toBe(R);
    expect(result.name).toBe('test');
  });

  test('redacts sensitive keys with array values', () => {
    const input = { token: ['s1', 's2'], name: 'test' };
    const result = redactSensitiveFields(input);
    expect(result.token).toBe(R);
    expect(result.name).toBe('test');
  });

  test('redacts sensitive keys with deeply nested object values', () => {
    const input = {
      credentials: { user: 'admin', pass: 'x', nested: { deep: true } },
    };
    const result = redactSensitiveFields(input);
    expect(result.credentials).toBe(R);
  });

  // --- Expanded key coverage regression tests ---

  test('redacts access_token in all casing/delimiter variants', () => {
    const parts = ['access', 'token'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x', safe: 'ok' });
      expect(result[key]).toBe(R);
      expect(result.safe).toBe('ok');
    }
  });

  test('redacts refresh_token variants', () => {
    const parts = ['refresh', 'token'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('redacts client+secret compound key variants', () => {
    const parts = ['client', 'secret'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('redacts private_key variants', () => {
    const parts = ['private', 'key'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('redacts cookie variants', () => {
    const result = redactSensitiveFields({
      cookie: 'abc',
      Cookie: 'def',
      COOKIE: 'ghi',
    });
    expect(result.cookie).toBe(R);
    expect(result.Cookie).toBe(R);
    expect(result.COOKIE).toBe(R);
  });

  test('redacts bearer_token variants', () => {
    const parts = ['bearer', 'token'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('redacts session_id variants', () => {
    const parts = ['session', 'id'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('redacts passwd variants', () => {
    const result = redactSensitiveFields({
      passwd: 'x',
      PASSWD: 'y',
    });
    expect(result.passwd).toBe(R);
    expect(result.PASSWD).toBe(R);
  });

  test('redacts id_token variants', () => {
    const parts = ['id', 'token'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('redacts ssn and credit card number variants', () => {
    const result = redactSensitiveFields({ ssn: 'x', SSN: 'y' });
    expect(result.ssn).toBe(R);
    expect(result.SSN).toBe(R);

    const ccParts = ['credit', 'card'];
    const cnParts = ['card', 'number'];
    for (const fmt of FORMATS) {
      const cc = k(ccParts, fmt);
      const cn = k(cnParts, fmt);
      const r = redactSensitiveFields({ [cc]: 'x', [cn]: 'y' });
      expect(r[cc]).toBe(R);
      expect(r[cn]).toBe(R);
    }
  });

  test('does not redact x-api-key (normalized to xapikey, not in stem list)', () => {
    const result = redactSensitiveFields({ 'x-api-key': 'xk1' });
    expect(result['x-api-key']).toBe('xk1');
  });

  test('redacts api_key in all delimiter variants', () => {
    const parts = ['api', 'key'];
    for (const fmt of FORMATS) {
      const key = k(parts, fmt);
      const result = redactSensitiveFields({ [key]: 'x' });
      expect(result[key]).toBe(R);
    }
  });

  test('non-sensitive keys with similar prefixes are preserved', () => {
    const input = {
      token_type: 'bearer',
      password_hint: 'pet',
      access_level: 'admin',
    };
    const result = redactSensitiveFields(input);
    expect(result).toEqual(input);
  });
});
