import { describe, expect, test } from 'bun:test';
import { detectQaIntent, shouldRouteQaToComputerUse } from '../daemon/qa-intent.js';

describe('detectQaIntent', () => {
  test('matches natural language QA phrasing', () => {
    expect(detectQaIntent('Hey assistant, can you help me test this behavior')).toBe(true);
    expect(detectQaIntent('I want to QA the vellum desktop app')).toBe(true);
  });

  test('does not match unrelated check requests', () => {
    expect(detectQaIntent('Can you check my email?')).toBe(false);
  });
});

describe('shouldRouteQaToComputerUse', () => {
  test('routes explicit UI/app QA requests to computer use', () => {
    expect(
      shouldRouteQaToComputerUse(
        'I want to QA the vellum desktop app and test out when a user types 2 lines in the composer',
      ),
    ).toBe(true);
    expect(shouldRouteQaToComputerUse('Please test this workflow by clicking Send in the app')).toBe(true);
  });

  test('does not force computer use for code-test requests', () => {
    expect(shouldRouteQaToComputerUse('Please write integration tests for this API handler')).toBe(false);
    expect(shouldRouteQaToComputerUse('Can you add unit tests using vitest for this util')).toBe(false);
  });
});
