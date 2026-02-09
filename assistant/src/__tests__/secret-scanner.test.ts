import { describe, test, expect } from 'bun:test';
import {
  scanText,
  redactSecrets,
  shannonEntropy,
  _isPlaceholder,
  _redact,
  _hasSecretContext,
  type SecretMatch,
} from '../security/secret-scanner.js';

// ---------------------------------------------------------------------------
// Helper: assert a single match of the expected type
// ---------------------------------------------------------------------------
function expectMatch(text: string, expectedType: string): SecretMatch {
  const matches = scanText(text);
  const found = matches.find((m) => m.type === expectedType);
  expect(found).toBeDefined();
  return found!;
}

function expectNoMatch(text: string): void {
  const matches = scanText(text);
  expect(matches).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------
describe('AWS keys', () => {
  test('detects AWS access key ID', () => {
    expectMatch('aws_access_key_id = AKIAIOSFODNN7REALKEY', 'AWS Access Key');
  });

  test('does not flag the AWS example key', () => {
    const matches = scanText('AKIAIOSFODNN7EXAMPLE');
    const aws = matches.filter((m) => m.type === 'AWS Access Key');
    expect(aws).toHaveLength(0);
  });

  test('detects AWS secret key after separator', () => {
    // Exactly 40 base-64 chars with mixed case and / (distinguishes from hex)
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYRE+LK3Yzab';
    expect(secret.length).toBe(40);
    expectMatch(
      `aws_secret_access_key = "${secret}"`,
      'AWS Secret Key',
    );
  });

  test('does not flag AWS example secret key', () => {
    const matches = scanText(
      'secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    );
    const aws = matches.filter((m) => m.type === 'AWS Secret Key');
    expect(aws).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
describe('GitHub tokens', () => {
  test('detects ghp_ personal access token', () => {
    expectMatch(
      `token=ghp_${'A'.repeat(36)}`,
      'GitHub Token',
    );
  });

  test('detects gho_ OAuth token', () => {
    expectMatch(
      `gho_${'B'.repeat(36)}`,
      'GitHub Token',
    );
  });

  test('detects fine-grained PAT', () => {
    expectMatch(
      `github_pat_${'C'.repeat(30)}`,
      'GitHub Fine-Grained PAT',
    );
  });
});

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------
describe('GitLab tokens', () => {
  test('detects glpat- token', () => {
    expectMatch('glpat-abcDEF1234567890abcde', 'GitLab Token');
  });
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
describe('Stripe keys', () => {
  test('detects live secret key', () => {
    expectMatch(`sk_live_${'a'.repeat(24)}`, 'Stripe Secret Key');
  });

  test('detects live restricted key', () => {
    expectMatch(`rk_live_${'b'.repeat(24)}`, 'Stripe Restricted Key');
  });

  test('does not flag test keys', () => {
    const matches = scanText(`sk_test_${'c'.repeat(24)}`);
    const stripe = matches.filter((m) => m.type === 'Stripe Secret Key');
    expect(stripe).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
describe('Slack tokens', () => {
  test('detects bot token', () => {
    expectMatch(
      'xoxb-1234567890-1234567890-aBcDeFgHiJkLmNoPqRsTuVwX',
      'Slack Bot Token',
    );
  });

  test('detects webhook URL', () => {
    expectMatch(
      'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
      'Slack Webhook',
    );
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
describe('Anthropic keys', () => {
  test('detects sk-ant- key', () => {
    expectMatch(`sk-ant-${'a'.repeat(80)}`, 'Anthropic API Key');
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
describe('OpenAI keys', () => {
  test('detects sk-proj- key', () => {
    expectMatch(`sk-proj-${'a'.repeat(40)}`, 'OpenAI Project Key');
  });

  test('detects classic OpenAI key format', () => {
    expectMatch(
      `sk-${'a'.repeat(20)}T3BlbkFJ${'b'.repeat(20)}`,
      'OpenAI API Key',
    );
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------
describe('Google keys', () => {
  test('detects AIza key', () => {
    // AIza + exactly 35 alphanumeric/dash/underscore chars
    const key = 'AIza' + 'SyA1bcDefGHijklMnoPQRStuvWXyz012345';
    expect(key.slice(4).length).toBe(35);
    expectMatch(key, 'Google API Key');
  });

  test('detects GOCSPX- client secret', () => {
    // GOCSPX- + exactly 28 chars
    const key = 'GOCSPX-' + 'aBcDeFgHiJkLmNoPqRsTuVwXy123';
    expect(key.slice(7).length).toBe(28);
    expectMatch(key, 'Google OAuth Client Secret');
  });
});

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------
describe('Twilio keys', () => {
  test('detects SK key', () => {
    expectMatch(`SK${'a'.repeat(32)}`, 'Twilio API Key');
  });
});

// ---------------------------------------------------------------------------
// SendGrid
// ---------------------------------------------------------------------------
describe('SendGrid keys', () => {
  test('detects SG. key', () => {
    expectMatch(
      `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`,
      'SendGrid API Key',
    );
  });
});

// ---------------------------------------------------------------------------
// Mailgun
// ---------------------------------------------------------------------------
describe('Mailgun keys', () => {
  test('detects key- format', () => {
    expectMatch(`key-${'c'.repeat(32)}`, 'Mailgun API Key');
  });
});

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------
describe('npm tokens', () => {
  test('detects npm_ token', () => {
    expectMatch(`npm_${'d'.repeat(36)}`, 'npm Token');
  });
});

// ---------------------------------------------------------------------------
// PyPI
// ---------------------------------------------------------------------------
describe('PyPI tokens', () => {
  test('detects pypi- token', () => {
    expectMatch(`pypi-${'e'.repeat(50)}`, 'PyPI API Token');
  });
});

// ---------------------------------------------------------------------------
// Private keys
// ---------------------------------------------------------------------------
describe('private keys', () => {
  test('detects RSA private key header', () => {
    expectMatch(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
      'Private Key',
    );
  });

  test('detects generic private key header', () => {
    expectMatch(
      '-----BEGIN PRIVATE KEY-----\nMIIE...',
      'Private Key',
    );
  });

  test('detects EC private key header', () => {
    expectMatch(
      '-----BEGIN EC PRIVATE KEY-----\nMIIE...',
      'Private Key',
    );
  });

  test('detects OPENSSH private key header', () => {
    expectMatch(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...',
      'Private Key',
    );
  });
});

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
describe('JSON Web Tokens', () => {
  test('detects JWT', () => {
    // A structurally valid JWT (base64url-encoded header.payload.signature)
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';
    const signature = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expectMatch(`${header}.${payload}.${signature}`, 'JSON Web Token');
  });
});

// ---------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------
describe('connection strings', () => {
  test('detects postgres connection string', () => {
    expectMatch(
      'postgres://user:secret@db.example.com:5432/mydb',
      'Database Connection String',
    );
  });

  test('detects mongodb+srv connection string', () => {
    expectMatch(
      'mongodb+srv://user:password@cluster.mongodb.net/db',
      'Database Connection String',
    );
  });

  test('detects redis connection string', () => {
    expectMatch(
      'redis://default:password@redis.example.com:6379',
      'Database Connection String',
    );
  });

  test('detects mysql connection string', () => {
    expectMatch(
      'mysql://root:secret@localhost:3306/app',
      'Database Connection String',
    );
  });
});

// ---------------------------------------------------------------------------
// Generic secret assignment
// ---------------------------------------------------------------------------
describe('generic secret assignments', () => {
  test('detects password = "value"', () => {
    expectMatch(
      'password = "SuperSecret123!"',
      'Generic Secret Assignment',
    );
  });

  test('detects api_key: "value"', () => {
    expectMatch(
      "api_key: 'my-real-api-key-value'",
      'Generic Secret Assignment',
    );
  });

  test('detects SECRET=value in quotes', () => {
    expectMatch(
      'SECRET="a-very-long-secret-value"',
      'Generic Secret Assignment',
    );
  });

  test('ignores short values (< 8 chars)', () => {
    // "short" is only 5 chars, should not match generic pattern
    const matches = scanText('password = "short"');
    const generic = matches.filter((m) => m.type === 'Generic Secret Assignment');
    expect(generic).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Placeholder / false-positive suppression
// ---------------------------------------------------------------------------
describe('placeholder detection', () => {
  test('suppresses known placeholder values', () => {
    expectNoMatch('password = "changeme"');
    expectNoMatch('password = "password"');
    expectNoMatch('password = "xxxxxxxx"');
  });

  test('suppresses test-prefixed keys', () => {
    expectNoMatch(`sk_test_${'a'.repeat(24)}`);
    expectNoMatch(`pk_test_${'b'.repeat(24)}`);
  });

  test('suppresses values containing example/placeholder/dummy', () => {
    expectNoMatch('token = "my-example-api-key-value"');
    expectNoMatch('key = "this-is-a-placeholder-string"');
    expectNoMatch('secret = "dummy-value-for-testing"');
  });

  test('suppresses all-same-character strings', () => {
    expectNoMatch('password = "aaaaaaaa"');
  });

  test('isPlaceholder returns true for known values', () => {
    expect(_isPlaceholder('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(_isPlaceholder('your-api-key-here')).toBe(true);
    expect(_isPlaceholder('changeme')).toBe(true);
  });

  test('isPlaceholder returns false for real-looking values', () => {
    expect(_isPlaceholder('wJalrXUtnFEMI/K7MDENG/bPxRfiCYREALKEY')).toBe(false);
    expect(_isPlaceholder('sk_live_abcdefghij1234567890abcd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
describe('redaction', () => {
  test('redact masks the middle of a string', () => {
    const result = _redact('AKIAIOSFODNN7REALKEY');
    // Should show first few + last few with stars in between
    expect(result).toContain('*');
    expect(result.length).toBeLessThanOrEqual(30);
    // First chars visible
    expect(result.startsWith('AKIA')).toBe(false); // only ~15% visible
    expect(result.startsWith('AK')).toBe(true);
  });

  test('redact handles short strings', () => {
    expect(_redact('short')).toBe('***');
  });

  test('redactSecrets replaces secrets in text', () => {
    const input = `export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7REALKEY`;
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED:AWS Access Key]');
    expect(result).not.toContain('AKIAIOSFODNN7REALKEY');
  });

  test('redactSecrets preserves text without secrets', () => {
    const input = 'Hello world, this is safe text.';
    expect(redactSecrets(input)).toBe(input);
  });

  test('redactSecrets handles multiple secrets', () => {
    const input = `
      AWS_KEY=AKIAIOSFODNN7REALKEY
      TOKEN=ghp_${'A'.repeat(36)}
    `;
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED:AWS Access Key]');
    expect(result).toContain('[REDACTED:GitHub Token]');
  });
});

// ---------------------------------------------------------------------------
// scanText behavior
// ---------------------------------------------------------------------------
describe('scanText', () => {
  test('returns empty array for safe text', () => {
    expect(scanText('just normal text with no secrets')).toHaveLength(0);
  });

  test('returns matches sorted by position', () => {
    const input = `second=ghp_${'A'.repeat(36)} first=AKIAIOSFODNN7REALKEY`;
    const matches = scanText(input);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].startIndex).toBeGreaterThanOrEqual(matches[i - 1].startIndex);
    }
  });

  test('does not flag common code patterns', () => {
    // git SHA (40 hex chars) should not be flagged as AWS secret
    // since it lacks a preceding separator
    const sha = '4b825dc642cb6eb9a060e54bf899d15f13fe1d7a';
    const matches = scanText(`commit ${sha}`);
    const awsMatches = matches.filter((m) => m.type === 'AWS Secret Key');
    expect(awsMatches).toHaveLength(0);
  });

  test('handles multi-line input', () => {
    const input = `
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWep4PAtGoSNQ==
-----END RSA PRIVATE KEY-----
    `;
    expectMatch(input, 'Private Key');
  });

  test('handles empty string', () => {
    expect(scanText('')).toHaveLength(0);
  });

  test('handles very long text without crashing', () => {
    const longText = 'a'.repeat(100_000);
    const start = performance.now();
    scanText(longText);
    const elapsed = performance.now() - start;
    // Should complete in under 500ms even for 100KB
    expect(elapsed).toBeLessThan(500);
  });

  test('match includes correct startIndex and endIndex', () => {
    const prefix = 'key is: ';
    const key = 'AKIAIOSFODNN7REALKEY';
    const input = prefix + key;
    const match = expectMatch(input, 'AWS Access Key');
    expect(match.startIndex).toBe(prefix.length);
    expect(match.endIndex).toBe(prefix.length + key.length);
    expect(input.slice(match.startIndex, match.endIndex)).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// Edge cases / false positives
// ---------------------------------------------------------------------------
describe('false positive resistance', () => {
  test('does not flag base64-encoded images', () => {
    // A typical short base64 image data chunk — should not trigger
    const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA';
    const matches = scanText(img);
    // May match JWT-like patterns; verify no AWS/generic matches
    const sensitive = matches.filter(
      (m) => m.type === 'AWS Secret Key' || m.type === 'Generic Secret Assignment',
    );
    expect(sensitive).toHaveLength(0);
  });

  test('does not flag UUIDs as Heroku keys when they are zero-filled', () => {
    const matches = scanText('00000000-0000-0000-0000-000000000000');
    const heroku = matches.filter((m) => m.type === 'Heroku API Key');
    expect(heroku).toHaveLength(0);
  });

  test('does not flag common hex strings without context', () => {
    // MD5/SHA hashes are hex but should not be flagged
    expectNoMatch('d41d8cd98f00b204e9800998ecf8427e');
  });

  test('does not flag public key headers', () => {
    const pubKey = '-----BEGIN PUBLIC KEY-----';
    const matches = scanText(pubKey);
    const privKeys = matches.filter((m) => m.type === 'Private Key');
    expect(privKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------
describe('shannonEntropy', () => {
  test('returns 0 for empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  test('returns 0 for single repeated character', () => {
    expect(shannonEntropy('aaaaaa')).toBe(0);
  });

  test('returns 1.0 for two equally distributed characters', () => {
    expect(shannonEntropy('ababab')).toBeCloseTo(1.0, 5);
  });

  test('returns high entropy for random-looking strings', () => {
    // A high-entropy hex string
    const entropy = shannonEntropy('a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4');
    expect(entropy).toBeGreaterThan(3.0);
  });

  test('returns lower entropy for structured/repetitive content', () => {
    const entropy = shannonEntropy('abcabcabcabcabcabc');
    expect(entropy).toBeLessThan(2.0);
  });
});

// ---------------------------------------------------------------------------
// Entropy-based secret detection
// ---------------------------------------------------------------------------
describe('entropy-based detection', () => {
  test('detects high-entropy hex token near secret keyword', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `api_key = ${hexSecret}`;
    const matches = scanText(input);
    const entropyMatch = matches.find((m) => m.type === 'High-Entropy Hex Token');
    expect(entropyMatch).toBeDefined();
    expect(entropyMatch!.startIndex).toBe(input.indexOf(hexSecret));
  });

  test('detects high-entropy base64 token near secret keyword', () => {
    const b64Secret = 'aB3cD4eF5gH6iJ7kL8mN+pQ/rS0tU1vW2xY3zA=';
    const input = `token: "${b64Secret}"`;
    const matches = scanText(input);
    const entropyMatch = matches.find((m) => m.type === 'High-Entropy Base64 Token');
    expect(entropyMatch).toBeDefined();
  });

  test('does not flag high-entropy hex without secret context', () => {
    const hexString = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    // No secret keyword nearby — just "checksum"
    const input = `checksum: ${hexString}`;
    const matches = scanText(input);
    const entropyMatches = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropyMatches).toHaveLength(0);
  });

  test('does not flag low-entropy tokens even with context', () => {
    // Repeated pattern = low entropy
    const lowEntropy = 'abcabcabcabcabcabcabcabc';
    const input = `secret = ${lowEntropy}`;
    const matches = scanText(input);
    const entropyMatches = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropyMatches).toHaveLength(0);
  });

  test('does not flag tokens shorter than minLength', () => {
    const shortToken = 'a3f8c1b2d9e4f5a6';
    const input = `api_key = ${shortToken}`;
    const matches = scanText(input);
    const entropyMatches = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropyMatches).toHaveLength(0);
  });

  test('can be disabled via config', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `api_key = ${hexSecret}`;
    const matches = scanText(input, { enabled: false });
    const entropyMatches = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropyMatches).toHaveLength(0);
  });

  test('respects custom threshold', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `api_key = ${hexSecret}`;

    // With extremely high threshold, nothing matches
    const matchesHigh = scanText(input, { hexThreshold: 10.0 });
    const entropyHigh = matchesHigh.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropyHigh).toHaveLength(0);

    // With low threshold, it matches
    const matchesLow = scanText(input, { hexThreshold: 1.0 });
    const entropyLow = matchesLow.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropyLow.length).toBeGreaterThan(0);
  });

  test('does not double-count tokens already matched by patterns', () => {
    // An AWS access key should only appear once (pattern match), not again as entropy
    const input = `api_key = AKIAIOSFODNN7REALKEY`;
    const matches = scanText(input);
    const awsMatches = matches.filter((m) => m.type === 'AWS Access Key');
    const entropyMatches = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(awsMatches).toHaveLength(1);
    // Should not have an entropy match for the same range
    expect(entropyMatches).toHaveLength(0);
  });

  test('recognizes various secret context keywords', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const keywords = ['secret', 'password', 'bearer', 'credentials', 'access_key', 'private_key'];
    for (const kw of keywords) {
      const input = `${kw} = ${hexSecret}`;
      const matches = scanText(input);
      const entropyMatches = matches.filter((m) => m.type.startsWith('High-Entropy'));
      expect(entropyMatches.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// hasSecretContext helper
// ---------------------------------------------------------------------------
describe('hasSecretContext', () => {
  test('detects keyword in prefix', () => {
    const text = 'api_key = abc123';
    expect(_hasSecretContext(text, 10)).toBe(true);
  });

  test('returns false without keyword', () => {
    const text = 'username = abc123';
    expect(_hasSecretContext(text, 11)).toBe(false);
  });

  test('detects keyword case-insensitively', () => {
    const text = 'API_KEY = abc123';
    expect(_hasSecretContext(text, 10)).toBe(true);
  });
});
