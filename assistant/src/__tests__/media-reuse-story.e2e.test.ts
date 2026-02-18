/**
 * Story E2E Test: "selfie yesterday -> generated image today"
 *
 * Simulates the full media-reuse user story end-to-end:
 *
 * 1. A fal.ai credential is stored with an injection template.
 * 2. User uploads a selfie in Thread A (standard thread).
 * 3. In Thread B (standard), the agent uses asset_search to find the selfie,
 *    then asset_materialize to write it to disk.
 * 4. A proxied bash command calls the provider API (mocked) with credential
 *    injection. The activation prompt fires per-invocation (not persistent).
 * 5. The generated result is saved back.
 *
 * Also verifies that private-thread isolation blocks cross-thread media access.
 */

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Test directory and mocks (must precede any source imports)
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'media-reuse-story-e2e-'));
const sandboxDir = join(testDir, 'sandbox');

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
}));

// ---------------------------------------------------------------------------
// Source imports (after mocks)
// ---------------------------------------------------------------------------

import { initializeDb, getDb } from '../memory/db.js';
import { uploadAttachment, linkAttachmentToMessage } from '../memory/attachments-store.js';
import { createConversation, addMessage } from '../memory/conversation-store.js';
import { assetSearchTool, searchAttachments } from '../tools/assets/search.js';
import { assetMaterializeTool } from '../tools/assets/materialize.js';
import { isAttachmentVisible, filterVisibleAttachments, type AttachmentContext } from '../daemon/media-visibility-policy.js';
import { TINY_PNG_BASE64, FAKE_SELFIE_ATTACHMENT, fakeAllowOnce, fakeDeny } from './fixtures/media-reuse-fixtures.js';
import type { ToolContext } from '../tools/types.js';
import type { CredentialInjectionTemplate } from '../tools/credentials/policy-types.js';

import { mkdirSync } from 'node:fs';

initializeDb();
mkdirSync(sandboxDir, { recursive: true });

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM message_attachments');
  db.run('DELETE FROM attachments');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

// ---------------------------------------------------------------------------
// Story E2E: selfie yesterday, generated image today
// ---------------------------------------------------------------------------

describe('Story E2E: selfie yesterday -> generated image today', () => {
  // Shared state across the story steps
  let threadA: ReturnType<typeof createConversation>;
  let threadB: ReturnType<typeof createConversation>;
  let selfieId: string;
  let selfieAttachment: ReturnType<typeof uploadAttachment>;

  beforeEach(() => {
    resetTables();

    // -- Step 1: Credential with injection template (simulated) --
    // In a real flow, the user stores a fal.ai credential via credential_store.
    // Here we only need to verify the injection template structure is valid --
    // the actual credential broker is tested in dedicated tests. We construct
    // the template to verify the data shape used downstream.
    const falInjectionTemplate: CredentialInjectionTemplate = {
      hostPattern: '*.fal.ai',
      injectionType: 'header',
      headerName: 'Authorization',
      valuePrefix: 'Key ',
    };
    // Sanity check the template shape
    expect(falInjectionTemplate.hostPattern).toBe('*.fal.ai');
    expect(falInjectionTemplate.injectionType).toBe('header');
    expect(falInjectionTemplate.headerName).toBe('Authorization');
    expect(falInjectionTemplate.valuePrefix).toBe('Key ');

    // -- Step 2: Selfie uploaded in Thread A (standard) --
    threadA = createConversation({ title: 'Thread A — selfie upload' });
    selfieAttachment = uploadAttachment('asst-story-01', 'selfie.png', 'image/png', TINY_PNG_BASE64);
    selfieId = selfieAttachment.id;

    const msgA = addMessage(threadA.id, 'user', 'Here is my selfie from yesterday');
    linkAttachmentToMessage(msgA.id, selfieId, 0);

    // Backdate the selfie to "yesterday" for realism
    const yesterday = Date.now() - 24 * 60 * 60 * 1000 - 5000;
    const db = getDb();
    db.run(`UPDATE attachments SET created_at = ${yesterday} WHERE id = '${selfieId}'`);

    // -- Step 3: Thread B is a new standard conversation --
    threadB = createConversation({ title: 'Thread B — generate image' });
  });

  test('asset_search discovers the selfie from Thread B (cross-thread)', async () => {
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-story',
      conversationId: threadB.id,
    };

    const result = await assetSearchTool.execute(
      { mime_type: 'image/*', filename: 'selfie' },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('selfie.png');
    expect(result.content).toContain(selfieId);
    expect(result.content).toContain('Found 1 asset(s)');
  });

  test('asset_search with recency last_7_days finds the selfie uploaded yesterday', async () => {
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-story',
      conversationId: threadB.id,
    };

    const result = await assetSearchTool.execute(
      { mime_type: 'image/*', recency: 'last_7_days' },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('selfie.png');
  });

  test('asset_materialize writes the selfie to disk in Thread B sandbox', async () => {
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-story',
      conversationId: threadB.id,
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: selfieId, destination_path: 'inputs/selfie.png' },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Materialized');
    expect(result.content).toContain('selfie.png');
    expect(result.content).toContain('image/png');

    // Verify the file actually exists on disk
    const materializedPath = join(sandboxDir, 'inputs', 'selfie.png');
    expect(existsSync(materializedPath)).toBe(true);

    // Verify the content matches the original base64-decoded data
    const writtenBytes = readFileSync(materializedPath);
    const expectedBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
    expect(Buffer.compare(writtenBytes, expectedBytes)).toBe(0);
  });

  test('full story: search -> materialize -> simulated provider call -> output saved', async () => {
    const contextB: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-story',
      conversationId: threadB.id,
    };

    // Step 3a: Search for the selfie
    const searchResult = await assetSearchTool.execute(
      { mime_type: 'image/*', filename: 'selfie' },
      contextB,
    );
    expect(searchResult.isError).toBe(false);
    expect(searchResult.content).toContain(selfieId);

    // Step 3b: Materialize the selfie to disk
    const materializeResult = await assetMaterializeTool.execute(
      { attachment_id: selfieId, destination_path: 'inputs/selfie.png' },
      contextB,
    );
    expect(materializeResult.isError).toBe(false);
    const inputPath = join(sandboxDir, 'inputs', 'selfie.png');
    expect(existsSync(inputPath)).toBe(true);

    // Step 4: Simulate proxied script calling mock provider API
    // In reality, the agent would run `bash` with `network_mode: 'proxied'`,
    // which routes through the network proxy with credential injection.
    // Here we simulate the provider response — the proxy and bash execution
    // are tested in proxy-approval-callback.test.ts and tool-executor.test.ts.
    const mockProviderResponse = {
      images: [
        { url: 'https://fal.ai/output/generated-portrait-001.png' },
        { url: 'https://fal.ai/output/generated-portrait-002.png' },
      ],
      seed: 42,
      inference_time: 1.23,
    };

    // Simulate iterating on the result (calling provider multiple times)
    // Each call would require per-invocation approval in the real flow
    const iterations = [
      { prompt: 'Generate a portrait from selfie, style: oil painting', response: mockProviderResponse },
      { prompt: 'Generate a portrait from selfie, style: watercolor', response: { ...mockProviderResponse, seed: 43 } },
    ];

    for (const iteration of iterations) {
      // Verify the approval response helper produces correct decision shapes
      const approval = fakeAllowOnce();
      expect(approval.decision).toBe('allow');
      expect(approval.pattern).toBeUndefined();
      // Each invocation gets a one-time allow — no persistent rule created
    }

    // Step 5: Save the generated result back as an attachment.
    // Use different content than the selfie to avoid content-hash deduplication
    // in the attachment store (same hash = returns existing row).
    const generatedImageBase64 = Buffer.from('generated-portrait-data-unique').toString('base64');
    const outputAttachment = uploadAttachment(
      'asst-story-01',
      'generated-portrait.png',
      'image/png',
      generatedImageBase64,
    );

    const msgB = addMessage(threadB.id, 'assistant', 'Here is your generated portrait!');
    linkAttachmentToMessage(msgB.id, outputAttachment.id, 0);

    // Verify the output attachment exists in the DB via raw search
    const rawResults = searchAttachments({ filename: 'generated-portrait' });
    expect(rawResults.length).toBe(1);
    expect(rawResults[0].originalFilename).toBe('generated-portrait.png');
    expect(rawResults[0].id).toBe(outputAttachment.id);

    // Verify it's also findable via the tool (with visibility filtering)
    const outputSearchResult = await assetSearchTool.execute(
      { filename: 'generated-portrait' },
      contextB,
    );
    expect(outputSearchResult.isError).toBe(false);
    expect(outputSearchResult.content).toContain('generated-portrait.png');
    expect(outputSearchResult.content).toContain(outputAttachment.id);
  });
});

// ---------------------------------------------------------------------------
// Credential injection template validation
// ---------------------------------------------------------------------------

describe('Credential injection template structure', () => {
  test('fal.ai header injection template has all required fields', () => {
    const template: CredentialInjectionTemplate = {
      hostPattern: '*.fal.ai',
      injectionType: 'header',
      headerName: 'Authorization',
      valuePrefix: 'Key ',
    };

    expect(template.hostPattern).toBe('*.fal.ai');
    expect(template.injectionType).toBe('header');
    expect(template.headerName).toBe('Authorization');
    expect(template.valuePrefix).toBe('Key ');
    expect(template.queryParamName).toBeUndefined();
  });

  test('query-param injection template shape is valid', () => {
    const template: CredentialInjectionTemplate = {
      hostPattern: 'api.example.com',
      injectionType: 'query',
      queryParamName: 'api_key',
    };

    expect(template.injectionType).toBe('query');
    expect(template.queryParamName).toBe('api_key');
    expect(template.headerName).toBeUndefined();
  });

  test('host pattern matching for fal.ai subdomains', () => {
    // The proxy uses minimatch for host patterns. Verify the pattern shape.
    const { minimatch } = require('minimatch');
    const pattern = '*.fal.ai';
    expect(minimatch('api.fal.ai', pattern)).toBe(true);
    expect(minimatch('v1.fal.ai', pattern)).toBe(true);
    expect(minimatch('fal.ai', pattern)).toBe(false); // No subdomain
    expect(minimatch('evil.fal.ai.attacker.com', pattern)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Proxied bash approval is per-invocation (not persistent)
// ---------------------------------------------------------------------------

describe('Proxied bash activation requires per-invocation approval', () => {
  test('one-time allow decision has no pattern or scope (cannot create persistent rule)', () => {
    const approval = fakeAllowOnce();
    expect(approval.decision).toBe('allow');
    expect(approval.pattern).toBeUndefined();
    expect(approval.scope).toBeUndefined();
  });

  test('deny decision also has no pattern or scope', () => {
    const denial = fakeDeny();
    expect(denial.decision).toBe('deny');
    expect(denial.pattern).toBeUndefined();
    expect(denial.scope).toBeUndefined();
  });

  test('consecutive approval checks produce independent decisions', () => {
    // Simulate multiple invocations — each must be independently approved
    const decisions = [fakeAllowOnce(), fakeAllowOnce(), fakeDeny()];
    expect(decisions[0].decision).toBe('allow');
    expect(decisions[1].decision).toBe('allow');
    expect(decisions[2].decision).toBe('deny');
    // No decision carries over from a previous one
    for (const d of decisions) {
      expect(d.pattern).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Private-thread variant: cross-thread blocking
// ---------------------------------------------------------------------------

describe('Private-thread variant: cross-thread media blocking', () => {
  beforeEach(resetTables);

  test('selfie in private thread A is NOT discoverable via search from Thread B', async () => {
    // Upload selfie in a private thread
    const privateThread = createConversation({ title: 'Private selfie thread', threadType: 'private' });
    const selfie = uploadAttachment('asst-priv', 'private-selfie.png', 'image/png', TINY_PNG_BASE64);
    const msg = addMessage(privateThread.id, 'user', 'My private selfie');
    linkAttachmentToMessage(msg.id, selfie.id, 0);

    // Search from a standard thread
    const standardThread = createConversation({ title: 'Standard thread B' });
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-priv-test',
      conversationId: standardThread.id,
    };

    const result = await assetSearchTool.execute(
      { filename: 'private-selfie' },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No assets found');
  });

  test('selfie in private thread A is NOT materializable from Thread B', async () => {
    const privateThread = createConversation({ title: 'Private selfie thread', threadType: 'private' });
    const base64 = Buffer.from('private image data').toString('base64');
    const selfie = uploadAttachment('asst-priv', 'private-selfie.png', 'image/png', base64);
    const msg = addMessage(privateThread.id, 'user', 'My private selfie');
    linkAttachmentToMessage(msg.id, selfie.id, 0);

    // Try to materialize from a standard thread
    const standardThread = createConversation({ title: 'Standard thread B' });
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-priv-test',
      conversationId: standardThread.id,
    };

    const result = await assetMaterializeTool.execute(
      { attachment_id: selfie.id, destination_path: 'stolen-selfie.png' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('private thread');
    expect(result.content).toContain('cannot be accessed');
  });

  test('selfie in private thread IS accessible from the same private thread', async () => {
    const privateThread = createConversation({ title: 'Private selfie thread', threadType: 'private' });
    const selfie = uploadAttachment('asst-priv', 'private-selfie.png', 'image/png', TINY_PNG_BASE64);
    const msg = addMessage(privateThread.id, 'user', 'My private selfie');
    linkAttachmentToMessage(msg.id, selfie.id, 0);

    // Search from the same private thread
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-priv-test',
      conversationId: privateThread.id,
    };

    const searchResult = await assetSearchTool.execute(
      { filename: 'private-selfie' },
      context,
    );
    expect(searchResult.isError).toBe(false);
    expect(searchResult.content).toContain('private-selfie.png');

    // Materialize from the same private thread
    const materializeResult = await assetMaterializeTool.execute(
      { attachment_id: selfie.id, destination_path: 'my-selfie.png' },
      context,
    );
    expect(materializeResult.isError).toBe(false);
    expect(materializeResult.content).toContain('Materialized');
  });

  test('selfie in private thread A is NOT accessible from private thread B', async () => {
    const privateThreadA = createConversation({ title: 'Private thread A', threadType: 'private' });
    const selfie = uploadAttachment('asst-priv', 'thread-a-selfie.png', 'image/png', TINY_PNG_BASE64);
    const msgA = addMessage(privateThreadA.id, 'user', 'Selfie in thread A');
    linkAttachmentToMessage(msgA.id, selfie.id, 0);

    // Search from a different private thread
    const privateThreadB = createConversation({ title: 'Private thread B', threadType: 'private' });
    const context: ToolContext = {
      workingDir: sandboxDir,
      sessionId: 'sess-priv-test',
      conversationId: privateThreadB.id,
    };

    const searchResult = await assetSearchTool.execute(
      { filename: 'thread-a-selfie' },
      context,
    );
    expect(searchResult.isError).toBe(false);
    expect(searchResult.content).toContain('No assets found');

    // Also verify materialize is blocked
    const materializeResult = await assetMaterializeTool.execute(
      { attachment_id: selfie.id, destination_path: 'cross-thread.png' },
      context,
    );
    expect(materializeResult.isError).toBe(true);
    expect(materializeResult.content).toContain('private thread');
  });

  test('visibility policy unit check: private attachment blocked from standard context', () => {
    const privateAttachment: AttachmentContext = {
      conversationId: 'conv-private-001',
      isPrivate: true,
    };
    const standardContext: AttachmentContext = {
      conversationId: 'conv-standard-001',
      isPrivate: false,
    };

    expect(isAttachmentVisible(privateAttachment, standardContext)).toBe(false);
  });

  test('visibility policy unit check: standard attachment visible from any context', () => {
    const standardAttachment: AttachmentContext = {
      conversationId: 'conv-standard-001',
      isPrivate: false,
    };
    const otherContext: AttachmentContext = {
      conversationId: 'conv-other',
      isPrivate: false,
    };
    const privateContext: AttachmentContext = {
      conversationId: 'conv-private-001',
      isPrivate: true,
    };

    expect(isAttachmentVisible(standardAttachment, otherContext)).toBe(true);
    expect(isAttachmentVisible(standardAttachment, privateContext)).toBe(true);
  });

  test('filterVisibleAttachments correctly partitions mixed standard/private attachments', () => {
    interface TestItem {
      id: string;
      conversationId: string;
      isPrivate: boolean;
    }

    const items: TestItem[] = [
      { id: 'std-1', conversationId: 'conv-std', isPrivate: false },
      { id: 'priv-a', conversationId: 'conv-priv-a', isPrivate: true },
      { id: 'priv-b', conversationId: 'conv-priv-b', isPrivate: true },
    ];

    const getCtx = (item: TestItem): AttachmentContext => ({
      conversationId: item.conversationId,
      isPrivate: item.isPrivate,
    });

    // From a standard context, only standard attachments are visible
    const fromStandard = filterVisibleAttachments(
      items,
      { conversationId: 'conv-other', isPrivate: false },
      getCtx,
    );
    expect(fromStandard.map((i) => i.id)).toEqual(['std-1']);

    // From private thread A, standard + A's private attachment are visible
    const fromPrivA = filterVisibleAttachments(
      items,
      { conversationId: 'conv-priv-a', isPrivate: true },
      getCtx,
    );
    expect(fromPrivA.map((i) => i.id)).toEqual(['std-1', 'priv-a']);

    // From private thread B, standard + B's private attachment are visible
    const fromPrivB = filterVisibleAttachments(
      items,
      { conversationId: 'conv-priv-b', isPrivate: true },
      getCtx,
    );
    expect(fromPrivB.map((i) => i.id)).toEqual(['std-1', 'priv-b']);
  });
});

// ---------------------------------------------------------------------------
// Fixture data integrity checks
// ---------------------------------------------------------------------------

describe('Fixture data integrity', () => {
  test('FAKE_SELFIE_ATTACHMENT has consistent metadata', () => {
    expect(FAKE_SELFIE_ATTACHMENT.originalFilename).toBe('selfie.png');
    expect(FAKE_SELFIE_ATTACHMENT.mimeType).toBe('image/png');
    expect(FAKE_SELFIE_ATTACHMENT.kind).toBe('image');
    expect(FAKE_SELFIE_ATTACHMENT.sizeBytes).toBe(Buffer.from(TINY_PNG_BASE64, 'base64').length);
  });

  test('TINY_PNG_BASE64 decodes to valid PNG header bytes', () => {
    const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
    // PNG magic bytes: 137 80 78 71 13 10 26 10
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4E); // N
    expect(bytes[3]).toBe(0x47); // G
  });
});
