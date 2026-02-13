import { describe, test, expect } from 'bun:test';
import { buildAuthForm, buildTimeoutMessage } from '../jit-auth.js';
import type { AuthChallenge } from '../auth-detector.js';

describe('buildAuthForm', () => {
  test('login challenge produces form with email (text) and password (password) fields', () => {
    const challenge: AuthChallenge = {
      type: 'login',
      service: 'Google',
      url: 'https://accounts.google.com/signin',
      fields: [
        { type: 'email', selector: '#identifierId', label: 'Google email' },
        { type: 'password', selector: 'input[type="password"]', label: 'Google password' },
      ],
    };

    const form = buildAuthForm(challenge);

    expect(form.fields).toHaveLength(2);

    expect(form.fields[0].id).toBe('email');
    expect(form.fields[0].type).toBe('text');
    expect(form.fields[0].label).toBe('Google email');
    expect(form.fields[0].placeholder).toBe('you@example.com');
    expect(form.fields[0].required).toBe(true);

    expect(form.fields[1].id).toBe('password');
    expect(form.fields[1].type).toBe('password');
    expect(form.fields[1].label).toBe('Google password');
    expect(form.fields[1].placeholder).toBe('Enter your password');
    expect(form.fields[1].required).toBe(true);
  });

  test('2FA challenge produces form with code (text) field', () => {
    const challenge: AuthChallenge = {
      type: '2fa',
      service: 'GitHub',
      url: 'https://github.com/sessions/two-factor',
      fields: [
        { type: 'code', selector: '#otp', label: 'verification code' },
      ],
    };

    const form = buildAuthForm(challenge);

    expect(form.fields).toHaveLength(1);
    expect(form.fields[0].id).toBe('code');
    expect(form.fields[0].type).toBe('text');
    expect(form.fields[0].label).toBe('verification code');
    expect(form.fields[0].placeholder).toBe('Enter the code');
    expect(form.fields[0].required).toBe(true);
  });

  test('OAuth consent challenge produces form with approval (toggle) field', () => {
    const challenge: AuthChallenge = {
      type: 'oauth_consent',
      service: 'Google',
      url: 'https://accounts.google.com/o/oauth2/consent',
      fields: [
        { type: 'approval', selector: '#approve', label: 'Allow' },
      ],
    };

    const form = buildAuthForm(challenge);

    expect(form.fields).toHaveLength(1);
    expect(form.fields[0].id).toBe('field_0');
    expect(form.fields[0].type).toBe('toggle');
    expect(form.fields[0].label).toBe('Allow');
    expect(form.fields[0].placeholder).toBeUndefined();
    expect(form.fields[0].required).toBe(true);
  });

  test('service name appears in description', () => {
    const challenge: AuthChallenge = {
      type: 'login',
      service: 'GitHub',
      url: 'https://github.com/login',
      fields: [
        { type: 'email', selector: '#login_field', label: 'email' },
      ],
    };

    const form = buildAuthForm(challenge);
    expect(form.description).toContain('GitHub');
  });

  test('default service name ("this website") when service is undefined', () => {
    const challenge: AuthChallenge = {
      type: 'login',
      service: undefined,
      url: 'https://example.com/login',
      fields: [
        { type: 'email', selector: '#email', label: 'email' },
      ],
    };

    const form = buildAuthForm(challenge);
    expect(form.description).toContain('this website');
  });

  test('submit label is "Continue" for login', () => {
    const challenge: AuthChallenge = {
      type: 'login',
      service: 'Google',
      url: 'https://accounts.google.com/signin',
      fields: [
        { type: 'email', selector: '#identifierId', label: 'email' },
      ],
    };

    const form = buildAuthForm(challenge);
    expect(form.submitLabel).toBe('Continue');
  });

  test('submit label is "Approve" for oauth_consent', () => {
    const challenge: AuthChallenge = {
      type: 'oauth_consent',
      service: 'Google',
      url: 'https://accounts.google.com/o/oauth2/consent',
      fields: [
        { type: 'approval', selector: '#approve', label: 'Allow' },
      ],
    };

    const form = buildAuthForm(challenge);
    expect(form.submitLabel).toBe('Approve');
  });

  test('submit label is "Continue" for 2fa', () => {
    const challenge: AuthChallenge = {
      type: '2fa',
      service: 'GitHub',
      url: 'https://github.com/sessions/two-factor',
      fields: [
        { type: 'code', selector: '#otp', label: 'verification code' },
      ],
    };

    const form = buildAuthForm(challenge);
    expect(form.submitLabel).toBe('Continue');
  });
});

describe('buildTimeoutMessage', () => {
  test('returns 2FA-specific message for 2fa challenges', () => {
    const challenge: AuthChallenge = {
      type: '2fa',
      service: 'GitHub',
      url: 'https://github.com/sessions/two-factor',
      fields: [
        { type: 'code', selector: '#otp', label: 'verification code' },
      ],
    };

    const message = buildTimeoutMessage(challenge);
    expect(message).toContain('verification code');
    expect(message).toContain('GitHub');
  });

  test('returns sign-in message for login challenges', () => {
    const challenge: AuthChallenge = {
      type: 'login',
      service: 'Google',
      url: 'https://accounts.google.com/signin',
      fields: [
        { type: 'email', selector: '#identifierId', label: 'email' },
      ],
    };

    const message = buildTimeoutMessage(challenge);
    expect(message).toContain('sign in');
    expect(message).toContain('Google');
  });

  test('uses "the website" when service is undefined', () => {
    const challenge: AuthChallenge = {
      type: 'login',
      service: undefined,
      url: 'https://example.com/login',
      fields: [
        { type: 'email', selector: '#email', label: 'email' },
      ],
    };

    const message = buildTimeoutMessage(challenge);
    expect(message).toContain('the website');
  });
});
