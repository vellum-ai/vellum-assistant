import { describe, test, expect } from 'bun:test';
import type { Part } from '@a2a-js/sdk';
import { extractVellumSocial, makeRequestPart, makeResponsePart, makeWorkingPart } from '../extension.js';

describe('extractVellumSocial', () => {
  test('returns null for empty parts array', () => {
    expect(extractVellumSocial([])).toBeNull();
  });

  test('returns null when no DataPart matches', () => {
    const parts: Part[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'data', data: { extension: 'some-other-extension', value: 42 } },
    ];
    expect(extractVellumSocial(parts)).toBeNull();
  });

  test('correctly extracts request data from parts', () => {
    const parts: Part[] = [
      { kind: 'text', text: 'requesting coffee order' },
      {
        kind: 'data',
        data: {
          extension: 'x-vellum-social-v1',
          connection_id: 'conn_123',
          sender_relationship: 'colleague',
          correlation_id: 'corr_abc',
        },
      },
    ];
    const result = extractVellumSocial(parts);
    expect(result).not.toBeNull();
    expect(result!.extension).toBe('x-vellum-social-v1');
    expect((result as { connection_id: string }).connection_id).toBe('conn_123');
    expect((result as { sender_relationship: string }).sender_relationship).toBe('colleague');
    expect((result as { correlation_id: string }).correlation_id).toBe('corr_abc');
  });

  test('correctly extracts response data from parts', () => {
    const parts: Part[] = [
      {
        kind: 'data',
        data: {
          extension: 'x-vellum-social-v1',
          response_basis: 'confirmed',
          correlation_id: 'corr_xyz',
        },
      },
    ];
    const result = extractVellumSocial(parts);
    expect(result).not.toBeNull();
    expect(result!.extension).toBe('x-vellum-social-v1');
    expect((result as { response_basis: string }).response_basis).toBe('confirmed');
    expect((result as { correlation_id: string }).correlation_id).toBe('corr_xyz');
  });
});

describe('makeRequestPart', () => {
  test('produces correct DataPart structure with extension field set', () => {
    const part = makeRequestPart({
      connection_id: 'conn_demo_peer1',
      sender_relationship: 'colleague',
      correlation_id: 'corr_001',
      deadline: '2026-01-01T12:00:00Z',
    });
    expect(part.kind).toBe('data');
    expect(part.data).toEqual({
      extension: 'x-vellum-social-v1',
      connection_id: 'conn_demo_peer1',
      sender_relationship: 'colleague',
      correlation_id: 'corr_001',
      deadline: '2026-01-01T12:00:00Z',
    });
  });
});

describe('makeResponsePart', () => {
  test('produces correct DataPart structure', () => {
    const part = makeResponsePart({
      response_basis: 'standing_preference',
      correlation_id: 'corr_002',
    });
    expect(part.kind).toBe('data');
    expect(part.data).toEqual({
      extension: 'x-vellum-social-v1',
      response_basis: 'standing_preference',
      correlation_id: 'corr_002',
    });
  });
});

describe('makeWorkingPart', () => {
  test('produces correct DataPart structure', () => {
    const part = makeWorkingPart({
      hitl_state: 'awaiting_human_input',
      correlation_id: 'corr_003',
    });
    expect(part.kind).toBe('data');
    expect(part.data).toEqual({
      extension: 'x-vellum-social-v1',
      hitl_state: 'awaiting_human_input',
      correlation_id: 'corr_003',
    });
  });
});
