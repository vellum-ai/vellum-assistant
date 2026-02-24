import { describe, test, expect } from 'bun:test';
import { twilioAuthHeader, twilioBaseUrl } from '../calls/twilio-rest.js';

describe('twilioAuthHeader', () => {
  test('returns a valid Basic auth header', () => {
    const header = twilioAuthHeader('AC_test_sid', 'test_token');
    const expected = 'Basic ' + Buffer.from('AC_test_sid:test_token').toString('base64');
    expect(header).toBe(expected);
  });

  test('encodes special characters correctly', () => {
    const header = twilioAuthHeader('AC_special!@#', 'tok$%^&');
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('AC_special!@#:tok$%^&');
  });
});

describe('twilioBaseUrl', () => {
  test('constructs correct base URL for a given account SID', () => {
    const url = twilioBaseUrl('AC_abc123');
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_abc123');
  });

  test('handles different account SIDs', () => {
    const url = twilioBaseUrl('AC_xyz789');
    expect(url).toContain('AC_xyz789');
    expect(url).toStartWith('https://api.twilio.com/2010-04-01/Accounts/');
  });
});
