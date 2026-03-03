import { describe, expect, test } from 'bun:test';

import { CURRENT_POLICY_EPOCH, isStaleEpoch } from '../policy.js';

describe('policy epoch', () => {
  test('CURRENT_POLICY_EPOCH is 1', () => {
    expect(CURRENT_POLICY_EPOCH).toBe(1);
  });

  test('epoch equal to current is not stale', () => {
    expect(isStaleEpoch(CURRENT_POLICY_EPOCH)).toBe(false);
  });

  test('epoch greater than current is not stale', () => {
    expect(isStaleEpoch(CURRENT_POLICY_EPOCH + 1)).toBe(false);
  });

  test('epoch less than current is stale', () => {
    expect(isStaleEpoch(CURRENT_POLICY_EPOCH - 1)).toBe(true);
  });

  test('epoch 0 is stale', () => {
    expect(isStaleEpoch(0)).toBe(true);
  });

  test('negative epoch is stale', () => {
    expect(isStaleEpoch(-1)).toBe(true);
  });
});
