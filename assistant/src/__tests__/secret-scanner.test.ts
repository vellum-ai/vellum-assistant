import { describe, test, expect } from 'bun:test';
import {
  scanText,
  redactSecrets,
  shannonEntropy,
  _isPlaceholder,
  _redact,
  _hasSecretContext,
  _tryDecodeBase64,
  _tryDecodePercentEncoded,
  _tryDecodeHexEscapes,
  _tryDecodeContinuousHex,
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
// Telegram
// ---------------------------------------------------------------------------
describe('Telegram bot tokens', () => {
  // Build test token at runtime to avoid tripping pre-commit secret hook
  const BOT_TOKEN = ['123456789', ':', 'ABCDefGHIJklmnopQRSTuvwxyz012345678'].join('');

  test('detects Telegram bot token', () => {
    expectMatch(`token=${BOT_TOKEN}`, 'Telegram Bot Token');
  });

  test('detects bot token in surrounding text', () => {
    expectMatch(`My bot token is ${BOT_TOKEN} please save it`, 'Telegram Bot Token');
  });

  test('detects bot token ending with hyphen', () => {
    // ~1.5% of valid tokens end with '-'; trailing \b would miss these
    const tokenEndingHyphen = ['123456789', ':', 'ABCDefGHIJklmnopQRSTuvwxyz01234567-'].join('');
    expectMatch(`token=${tokenEndingHyphen}`, 'Telegram Bot Token');
  });

  test('does not flag short numeric:alpha strings', () => {
    // Too few digits in bot ID (only 5)
    const matches = scanText('12345:ABCDefGHIJklmnopQRSTuvwxyz012345678');
    const telegram = matches.filter((m) => m.type === 'Telegram Bot Token');
    expect(telegram).toHaveLength(0);
  });

  test('does not flag token with wrong secret length', () => {
    // Secret part is only 10 chars (needs 35)
    const matches = scanText('123456789:ABCDefGHIJ');
    const telegram = matches.filter((m) => m.type === 'Telegram Bot Token');
    expect(telegram).toHaveLength(0);
  });

  test('does not flag token with too-long secret part', () => {
    // Secret part is 40 chars (needs exactly 35)
    const matches = scanText('123456789:ABCDefGHIJklmnopQRSTuvwxyz0123456789AB');
    const telegram = matches.filter((m) => m.type === 'Telegram Bot Token');
    expect(telegram).toHaveLength(0);
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
    expect(result).toContain('<redacted type="AWS Access Key" />');
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
    expect(result).toContain('<redacted type="AWS Access Key" />');
    expect(result).toContain('<redacted type="GitHub Token" />');
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
    // Use context that triggers entropy detection but not generic assignment pattern
    const input = `The signing_key is ${hexSecret}`;
    const matches = scanText(input);
    const entropyMatch = matches.find((m) => m.type === 'High-Entropy Hex Token');
    expect(entropyMatch).toBeDefined();
    expect(entropyMatch!.startIndex).toBe(input.indexOf(hexSecret));
  });

  test('detects high-entropy base64 token near secret keyword', () => {
    const b64Secret = 'aB3cD4eF5gH6iJ7kL8mN+pQ/rS0tU1vW2xY3zA=';
    // Use "is" instead of ": " to avoid triggering the generic assignment pattern
    const input = `The token is ${b64Secret}`;
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
    const input = `The signing_key is ${hexSecret}`;

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
    // Use "is" instead of "=" to avoid matching the generic assignment pattern
    const keywords = ['bearer', 'credential', 'private_key', 'signing_key', 'encryption_key'];
    for (const kw of keywords) {
      const input = `The ${kw} is ${hexSecret}`;
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

// ---------------------------------------------------------------------------
// Overlapping match handling in redactSecrets (#166 feedback)
// ---------------------------------------------------------------------------
describe('overlapping match redaction', () => {
  test('does not corrupt output when matches overlap', () => {
    // An AWS key inside a generic secret assignment produces overlapping matches
    const input = `api_key = "AKIAIOSFODNN7REALKEY"`;
    const result = redactSecrets(input);
    // Should redact correctly without duplicating markers or losing text
    expect(result).not.toContain('AKIAIOSFODNN7REALKEY');
    // The outer quotes should be preserved somewhere in the output
    expect(result).toContain('<redacted type="');
  });

  test('skips nested match and preserves surrounding text', () => {
    // Construct a case where a specific match is entirely inside a broader one
    const input = `password = "AKIAIOSFODNN7REALKEY inside text"`;
    const result = redactSecrets(input);
    // Should have at least one redaction
    expect(result).toContain('<redacted type="');
    // Should not contain the raw key
    expect(result).not.toContain('AKIAIOSFODNN7REALKEY');
  });

  test('wider overlapping match extends redaction span (#172 feedback)', () => {
    // A shorter match (e.g. AWS-like 40 chars) inside a longer generic assignment
    // should not leak the suffix of the longer match
    const input = `password = "AKIAIOSFODNN7REALKEY extra-tail-secret"`;
    const result = redactSecrets(input);
    // Nothing from the original secret value should leak
    expect(result).not.toContain('extra-tail-secret');
    expect(result).not.toContain('AKIAIOSFODNN7REALKEY');
    expect(result).toContain('<redacted type="');
  });

  test('wider match at same start position wins', () => {
    // When two matches start at same offset, wider one should be used
    const input = `token = "AKIAIOSFODNN7REALKEY-plus-extra-data"`;
    const result = redactSecrets(input);
    expect(result).not.toContain('AKIAIOSFODNN7REALKEY');
    expect(result).not.toContain('plus-extra-data');
    expect(result).toContain('<redacted type="');
  });
});

// ---------------------------------------------------------------------------
// Heroku UUID context requirement (#166 feedback)
// ---------------------------------------------------------------------------
describe('Heroku API Key', () => {
  test('detects UUID with heroku context keyword', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const input = `HEROKU_API_KEY=${uuid}`;
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === 'Heroku API Key');
    expect(heroku).toHaveLength(1);
  });

  test('detects UUID with heroku_auth_token prefix', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const input = `heroku_auth_token = "${uuid}"`;
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === 'Heroku API Key');
    expect(heroku).toHaveLength(1);
  });

  test('does not flag random UUIDs without heroku context', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const input = `request_id: ${uuid}`;
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === 'Heroku API Key');
    expect(heroku).toHaveLength(0);
  });

  test('does not flag UUIDs in logs', () => {
    const input = 'Processed request id=a1b2c3d4-e5f6-7890-abcd-ef1234567890 in 42ms';
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === 'Heroku API Key');
    expect(heroku).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unquoted generic secret assignments (#166 feedback)
// ---------------------------------------------------------------------------
describe('unquoted generic secret assignments', () => {
  test('detects .env-style unquoted password', () => {
    const input = 'DATABASE_PASSWORD=supersecret123';
    const matches = scanText(input);
    const generic = matches.filter((m) => m.type === 'Generic Secret Assignment');
    expect(generic.length).toBeGreaterThan(0);
  });

  test('detects .env-style unquoted api key', () => {
    const input = 'API_KEY=abcdef1234567890';
    const matches = scanText(input);
    const generic = matches.filter((m) => m.type === 'Generic Secret Assignment');
    expect(generic.length).toBeGreaterThan(0);
  });

  test('detects unquoted token assignment', () => {
    const input = 'AUTH_TOKEN=mysecuretokenvalue123';
    const matches = scanText(input);
    const generic = matches.filter((m) => m.type === 'Generic Secret Assignment');
    expect(generic.length).toBeGreaterThan(0);
  });

  test('still detects quoted assignments', () => {
    const input = `secret = "mysupersecretsecret"`;
    const matches = scanText(input);
    const generic = matches.filter((m) => m.type === 'Generic Secret Assignment');
    expect(generic.length).toBeGreaterThan(0);
  });

  test('does not match short unquoted values', () => {
    const input = 'password=short';
    const matches = scanText(input);
    const generic = matches.filter((m) => m.type === 'Generic Secret Assignment');
    expect(generic).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Base64 padding in entropy detection (#169 feedback)
// ---------------------------------------------------------------------------
describe('base64 padding handling', () => {
  test('includes trailing = padding in the match', () => {
    const b64 = 'aB3cD4eF5gH6iJ7kL8mN9pQrS0tU1vW2xY3zA=';
    const input = `token: ${b64}`;
    const matches = scanText(input);
    const entropyMatch = matches.find((m) => m.type === 'High-Entropy Base64 Token');
    expect(entropyMatch).toBeDefined();
    // endIndex should include the '='
    expect(input.slice(entropyMatch!.startIndex, entropyMatch!.endIndex)).toContain('=');
  });

  test('includes trailing == padding in the match', () => {
    const b64 = 'aB3cD4eF5gH6iJ7kL8mN9pQrS0tU1vW2x==';
    const input = `token: ${b64}`;
    const matches = scanText(input);
    const entropyMatch = matches.find((m) => m.type === 'High-Entropy Base64 Token');
    expect(entropyMatch).toBeDefined();
    expect(input.slice(entropyMatch!.startIndex, entropyMatch!.endIndex)).toContain('==');
  });

  test('redactSecrets fully redacts padded base64 tokens', () => {
    const b64 = 'aB3cD4eF5gH6iJ7kL8mN9pQrS0tU1vW2xY3zA=';
    const input = `token: "${b64}"`;
    const result = redactSecrets(input);
    // No trailing '=' should leak after redaction
    expect(result).not.toMatch(/<redacted type="[^"]+" \/>=/)
    expect(result).toContain('<redacted type="');
  });
});

// ---------------------------------------------------------------------------
// Word-boundary context keyword matching (#169 feedback)
// ---------------------------------------------------------------------------
describe('word-boundary context keywords', () => {
  test('does not match "key" inside "monkey"', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `monkey: ${hexSecret}`;
    const matches = scanText(input);
    const entropy = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropy).toHaveLength(0);
  });

  test('does not match "key" inside "keyboard"', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `keyboard = ${hexSecret}`;
    const matches = scanText(input);
    const entropy = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropy).toHaveLength(0);
  });

  test('does not match "token" inside "tokenizer"', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `tokenizer: ${hexSecret}`;
    const matches = scanText(input);
    const entropy = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropy).toHaveLength(0);
  });

  test('still matches "key" as a standalone word', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `The key is ${hexSecret}`;
    const matches = scanText(input);
    const entropy = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropy.length).toBeGreaterThan(0);
  });

  test('still matches "api_key" with underscores', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `The api_key is ${hexSecret}`;
    const matches = scanText(input);
    const entropy = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropy.length).toBeGreaterThan(0);
  });

  test('still matches "api-key" with hyphens', () => {
    const hexSecret = 'a3f8c1b2d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    const input = `The api-key is ${hexSecret}`;
    const matches = scanText(input);
    const entropy = matches.filter((m) => m.type.startsWith('High-Entropy'));
    expect(entropy.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Encoded secret detection — decode + re-scan
// ---------------------------------------------------------------------------
describe('encoded secret detection', () => {
  // -- Base64-encoded secrets --
  describe('base64-encoded', () => {
    test('detects base64-encoded Stripe key', () => {
      const secret = 'sk_live_abcdefghijklmnopqrstuvwx';
      const encoded = Buffer.from(secret).toString('base64');
      const input = `config: ${encoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'Stripe Secret Key (base64-encoded)');
      expect(found).toBeDefined();
    });

    test('detects base64-encoded GitHub token', () => {
      const secret = `ghp_${'A'.repeat(36)}`;
      const encoded = Buffer.from(secret).toString('base64');
      const input = `value=${encoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'GitHub Token (base64-encoded)');
      expect(found).toBeDefined();
    });

    test('detects base64-encoded private key header', () => {
      const secret = '-----BEGIN RSA PRIVATE KEY-----';
      const encoded = Buffer.from(secret).toString('base64');
      const input = `data: ${encoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'Private Key (base64-encoded)');
      expect(found).toBeDefined();
    });

    test('does not flag base64 that decodes to non-secret text', () => {
      const encoded = Buffer.from('Hello, this is just normal text!').toString('base64');
      const input = `data: ${encoded}`;
      const matches = scanText(input);
      const encoded_matches = matches.filter((m) => m.type.includes('base64-encoded'));
      expect(encoded_matches).toHaveLength(0);
    });

    test('does not flag base64 that decodes to binary data', () => {
      // Create a base64 string that decodes to non-printable bytes
      const binary = Buffer.from([0x00, 0x01, 0x02, 0x80, 0xff, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15]);
      const encoded = binary.toString('base64');
      const input = `data: ${encoded}`;
      const matches = scanText(input);
      const encoded_matches = matches.filter((m) => m.type.includes('base64-encoded'));
      expect(encoded_matches).toHaveLength(0);
    });

    test('does not double-count secrets already detected by raw patterns', () => {
      // A JWT is already detected directly — should not be re-detected as base64-encoded
      const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';
      const signature = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const jwt = `${header}.${payload}.${signature}`;
      const input = `token: ${jwt}`;
      const matches = scanText(input);
      const jwtMatches = matches.filter((m) => m.type === 'JSON Web Token');
      const encodedMatches = matches.filter((m) => m.type.includes('base64-encoded'));
      expect(jwtMatches).toHaveLength(1);
      expect(encodedMatches).toHaveLength(0);
    });
  });

  // -- Percent-encoded secrets --
  describe('percent-encoded', () => {
    test('detects percent-encoded database connection string', () => {
      const secret = 'postgres://user:secret@db.example.com:5432/mydb';
      const encoded = encodeURIComponent(secret);
      const input = `url=${encoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'Database Connection String (percent-encoded)');
      expect(found).toBeDefined();
    });

    test('detects percent-encoded secret assignment', () => {
      const encoded = 'password%3D%22SuperSecret123%21%22';
      const input = `data=${encoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type.includes('percent-encoded'));
      expect(found).toBeDefined();
    });

    test('does not flag percent-encoded non-secret text', () => {
      const encoded = 'hello%20world%20this%20is%20normal';
      const input = `text=${encoded}`;
      const matches = scanText(input);
      const encoded_matches = matches.filter((m) => m.type.includes('percent-encoded'));
      expect(encoded_matches).toHaveLength(0);
    });
  });

  // -- Hex-escaped secrets --
  describe('hex-escaped', () => {
    test('detects hex-escaped Stripe key', () => {
      const secret = 'sk_live_abcdefghijklmnopqrstuvwx';
      const escaped = Array.from(secret).map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
      const input = `value = "${escaped}"`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'Stripe Secret Key (hex-escaped)');
      expect(found).toBeDefined();
    });

    test('does not flag hex-escaped non-secret text', () => {
      const escaped = '\\x48\\x65\\x6c\\x6c\\x6f';
      const input = `value = "${escaped}"`;
      const matches = scanText(input);
      const encoded_matches = matches.filter((m) => m.type.includes('hex-escaped'));
      expect(encoded_matches).toHaveLength(0);
    });
  });

  // -- Continuous hex-encoded secrets --
  describe('hex-encoded (continuous)', () => {
    test('detects hex-encoded GitHub token', () => {
      const secret = `ghp_${'A'.repeat(36)}`;
      const hexEncoded = Buffer.from(secret).toString('hex');
      const input = `payload: ${hexEncoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'GitHub Token (hex-encoded)');
      expect(found).toBeDefined();
    });

    test('detects hex-encoded AWS access key', () => {
      const secret = 'AKIAIOSFODNN7REALKEY';
      const hexEncoded = Buffer.from(secret).toString('hex');
      const input = `data: ${hexEncoded}`;
      const matches = scanText(input);
      const found = matches.find((m) => m.type === 'AWS Access Key (hex-encoded)');
      expect(found).toBeDefined();
    });

    test('does not flag hex strings that decode to non-secret text', () => {
      const hexEncoded = Buffer.from('This is just normal harmless text').toString('hex');
      const input = `data: ${hexEncoded}`;
      const matches = scanText(input);
      const encoded_matches = matches.filter((m) => m.type.includes('hex-encoded'));
      expect(encoded_matches).toHaveLength(0);
    });

    test('does not flag git SHAs or similar hex hashes', () => {
      // 40-char hex SHA — too short to decode to a meaningful secret
      const sha = '4b825dc642cb6eb9a060e54bf899d15f13fe1d7a';
      const input = `commit: ${sha}`;
      const matches = scanText(input);
      const encoded_matches = matches.filter((m) => m.type.includes('hex-encoded'));
      expect(encoded_matches).toHaveLength(0);
    });
  });

  // -- Redaction of encoded secrets --
  describe('redaction of encoded secrets', () => {
    test('redactSecrets replaces base64-encoded secrets', () => {
      const secret = 'sk_live_abcdefghijklmnopqrstuvwx';
      const encoded = Buffer.from(secret).toString('base64');
      const input = `config: ${encoded}`;
      const result = redactSecrets(input);
      expect(result).toContain('<redacted type="Stripe Secret Key (base64-encoded)" />');
      expect(result).not.toContain(encoded);
    });

    test('redactSecrets replaces hex-encoded secrets', () => {
      const secret = `ghp_${'A'.repeat(36)}`;
      const hexEncoded = Buffer.from(secret).toString('hex');
      const input = `data: ${hexEncoded}`;
      const result = redactSecrets(input);
      expect(result).toContain('<redacted type="GitHub Token (hex-encoded)" />');
      expect(result).not.toContain(hexEncoded);
    });
  });
});

// ---------------------------------------------------------------------------
// Decode helper unit tests
// ---------------------------------------------------------------------------
describe('decode helpers', () => {
  test('tryDecodeBase64 returns decoded text for valid base64', () => {
    const encoded = Buffer.from('sk_live_abcdefghijklmnopqrstuvwx').toString('base64');
    expect(_tryDecodeBase64(encoded)).toBe('sk_live_abcdefghijklmnopqrstuvwx');
  });

  test('tryDecodeBase64 returns null for binary content', () => {
    const binary = Buffer.from([0x00, 0x01, 0x80, 0xff]).toString('base64');
    expect(_tryDecodeBase64(binary)).toBeNull();
  });

  test('tryDecodeBase64 returns null for invalid base64', () => {
    expect(_tryDecodeBase64('not!!valid!!base64!!')).toBeNull();
  });

  test('tryDecodePercentEncoded returns decoded text', () => {
    expect(_tryDecodePercentEncoded('hello%20world%21')).toBe('hello world!');
  });

  test('tryDecodePercentEncoded returns null when nothing to decode', () => {
    expect(_tryDecodePercentEncoded('no-encoding-here')).toBeNull();
  });

  test('tryDecodeHexEscapes returns decoded text', () => {
    expect(_tryDecodeHexEscapes('\\x48\\x65\\x6c\\x6c\\x6f')).toBe('Hello');
  });

  test('tryDecodeHexEscapes returns null when no escapes', () => {
    expect(_tryDecodeHexEscapes('plain text')).toBeNull();
  });

  test('tryDecodeContinuousHex returns decoded text', () => {
    const hex = Buffer.from('Hello').toString('hex');
    expect(_tryDecodeContinuousHex(hex)).toBe('Hello');
  });

  test('tryDecodeContinuousHex returns null for non-printable result', () => {
    // Hex that decodes to binary
    expect(_tryDecodeContinuousHex('0001ff80')).toBeNull();
  });
});
