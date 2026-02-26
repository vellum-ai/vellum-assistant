import { describe, expect, test } from 'bun:test';

import { resolveGuardianVerificationIntent } from '../daemon/guardian-verification-intent.js';

// =====================================================================
// 1. Direct guardian setup phrases => forced flow
// =====================================================================

describe('Direct guardian setup phrases route to direct_setup', () => {
  const directSetupPhrases = [
    'verify me as guardian',
    'verify me as your guardian',
    'confirm me as guardian',
    'confirm me as your guardian',
    'set me as guardian',
    'set me up as guardian',
    'set me up as your guardian',
    'help me confirm myself as your guardian by phone',
    'help me verify myself as your guardian',
    'set up guardian verification',
    'setup guardian verification',
    'verify guardian',
    'verify my guardian',
    'start guardian verification',
    'begin guardian verification',
    'verify my phone number',
    'verify my phone',
    'verify my telegram',
    'verify my telegram account',
    'verify voice channel',
    'verify my voice',
    'verify my voice channel',
    'set guardian for SMS',
    'set guardian for voice',
    'set guardian for telegram',
    'help me set myself up as your guardian',
    'I want to be your guardian',
    "I'd like to be your guardian",
    'make me your guardian',
    'make me a guardian',
    'add me as guardian',
    'add me as your guardian',
    'guardian setup',
    'guardian verification setup',
    'set up guardian',
    'set up my guardian',
  ];

  for (const phrase of directSetupPhrases) {
    test(`"${phrase}" => direct_setup`, () => {
      const result = resolveGuardianVerificationIntent(phrase);
      expect(result.kind).toBe('direct_setup');
    });
  }

  test('polite prefixes still match', () => {
    const result = resolveGuardianVerificationIntent('please verify me as guardian');
    expect(result.kind).toBe('direct_setup');
  });

  test('hey prefix still matches', () => {
    const result = resolveGuardianVerificationIntent('hey, set me up as guardian');
    expect(result.kind).toBe('direct_setup');
  });
});

// =====================================================================
// 2. Channel hint detection
// =====================================================================

describe('Channel hint detection', () => {
  test('SMS hint detected from "set guardian for SMS"', () => {
    const result = resolveGuardianVerificationIntent('set guardian for SMS');
    expect(result.kind).toBe('direct_setup');
    if (result.kind === 'direct_setup') {
      expect(result.channelHint).toBe('sms');
    }
  });

  test('voice hint detected from "verify my voice channel"', () => {
    const result = resolveGuardianVerificationIntent('verify my voice channel');
    expect(result.kind).toBe('direct_setup');
    if (result.kind === 'direct_setup') {
      expect(result.channelHint).toBe('voice');
    }
  });

  test('telegram hint detected from "verify my telegram"', () => {
    const result = resolveGuardianVerificationIntent('verify my telegram');
    expect(result.kind).toBe('direct_setup');
    if (result.kind === 'direct_setup') {
      expect(result.channelHint).toBe('telegram');
    }
  });

  test('phone hint detected from "help me confirm myself as your guardian by phone"', () => {
    const result = resolveGuardianVerificationIntent('help me confirm myself as your guardian by phone');
    expect(result.kind).toBe('direct_setup');
    if (result.kind === 'direct_setup') {
      expect(result.channelHint).toBe('voice');
    }
  });

  test('no channel hint when none specified', () => {
    const result = resolveGuardianVerificationIntent('verify me as guardian');
    expect(result.kind).toBe('direct_setup');
    if (result.kind === 'direct_setup') {
      expect(result.channelHint).toBeUndefined();
    }
  });
});

// =====================================================================
// 3. Conceptual / security questions => no forced routing (passthrough)
// =====================================================================

describe('Conceptual questions do not force routing', () => {
  const conceptualPhrases = [
    "why can't you verify over phone?",
    'what is guardian verification?',
    'how does guardian verification work?',
    'what does guardian mean?',
    'can you explain guardian verification?',
    'tell me about guardian verification',
    'is it possible to verify my guardian by email?',
    'is there a way to set up guardian verification without a phone?',
  ];

  for (const phrase of conceptualPhrases) {
    test(`"${phrase}" => passthrough (not direct_setup)`, () => {
      const result = resolveGuardianVerificationIntent(phrase);
      expect(result.kind).not.toBe('direct_setup');
      // Should be either passthrough or none, but never direct_setup
      expect(['passthrough', 'none']).toContain(result.kind);
    });
  }
});

// =====================================================================
// 4. Non-guardian unrelated messages => none (unchanged)
// =====================================================================

describe('Non-guardian messages return none', () => {
  const unrelatedPhrases = [
    'what is the weather today?',
    'send an email to John',
    'record my screen',
    'help me write a cover letter',
    'set a reminder for 3pm',
    'tell me a joke',
    '',
    '   ',
  ];

  for (const phrase of unrelatedPhrases) {
    test(`"${phrase}" => none`, () => {
      const result = resolveGuardianVerificationIntent(phrase);
      expect(result.kind).toBe('none');
    });
  }
});

// =====================================================================
// 5. Slash commands are never intercepted
// =====================================================================

describe('Slash commands are never intercepted', () => {
  test('"/guardian-verify-setup" => none', () => {
    const result = resolveGuardianVerificationIntent('/guardian-verify-setup');
    expect(result.kind).toBe('none');
  });

  test('"/model" => none', () => {
    const result = resolveGuardianVerificationIntent('/model');
    expect(result.kind).toBe('none');
  });

  test('"/verify guardian" => none', () => {
    const result = resolveGuardianVerificationIntent('/verify guardian');
    expect(result.kind).toBe('none');
  });
});

// =====================================================================
// 6. Edge cases
// =====================================================================

describe('Edge cases', () => {
  test('mixed case "VERIFY ME AS GUARDIAN" => direct_setup', () => {
    const result = resolveGuardianVerificationIntent('VERIFY ME AS GUARDIAN');
    expect(result.kind).toBe('direct_setup');
  });

  test('extra whitespace is handled', () => {
    const result = resolveGuardianVerificationIntent('  verify me as guardian  ');
    expect(result.kind).toBe('direct_setup');
  });

  test('guardian keyword without direct setup pattern => passthrough', () => {
    const result = resolveGuardianVerificationIntent('I have a question about guardian permissions');
    expect(result.kind).toBe('passthrough');
  });
});
