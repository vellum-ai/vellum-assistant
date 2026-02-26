import { describe, expect, test } from 'bun:test';

import { isValidE164, normalizePhoneNumber } from '../util/phone.js';

describe('normalizePhoneNumber', () => {
  test('already E.164 — returned as-is', () => {
    expect(normalizePhoneNumber('+15551234567')).toBe('+15551234567');
  });

  test('10-digit US number — prepends +1', () => {
    expect(normalizePhoneNumber('5551234567')).toBe('+15551234567');
  });

  test('11-digit number starting with 1 — prepends +', () => {
    expect(normalizePhoneNumber('15551234567')).toBe('+15551234567');
  });

  test('strips parentheses and spaces', () => {
    expect(normalizePhoneNumber('(555) 123-4567')).toBe('+15551234567');
  });

  test('strips dots', () => {
    expect(normalizePhoneNumber('555.123.4567')).toBe('+15551234567');
  });

  test('strips dashes', () => {
    expect(normalizePhoneNumber('555-123-4567')).toBe('+15551234567');
  });

  test('international with spaces', () => {
    expect(normalizePhoneNumber('+44 20 7946 0958')).toBe('+442079460958');
  });

  test('too short — returns null', () => {
    expect(normalizePhoneNumber('123')).toBeNull();
  });

  test('non-numeric — returns null', () => {
    expect(normalizePhoneNumber('abc')).toBeNull();
  });

  test('empty string — returns null', () => {
    expect(normalizePhoneNumber('')).toBeNull();
  });
});

describe('isValidE164', () => {
  test('valid E.164 number', () => {
    expect(isValidE164('+15551234567')).toBe(true);
  });

  test('missing + prefix', () => {
    expect(isValidE164('5551234567')).toBe(false);
  });

  test('too short', () => {
    expect(isValidE164('+123')).toBe(false);
  });
});
