import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToolManifest, parseToolManifestFile } from '../skills/tool-manifest.js';
import type { SkillToolManifest } from '../config/skills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-tool',
    description: 'A test tool',
    category: 'testing',
    risk: 'low',
    input_schema: { type: 'object', properties: {} },
    executor: 'tools/run.ts',
    execution_target: 'host',
    ...overrides,
  };
}

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    tools: [makeToolEntry()],
    ...overrides,
  };
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skill-tool-manifest-test-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseToolManifest — happy path
// ---------------------------------------------------------------------------

describe('parseToolManifest', () => {
  test('parses a valid manifest with one tool', () => {
    const raw = makeManifest();
    const result = parseToolManifest(raw);

    expect(result.version).toBe(1);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('test-tool');
    expect(result.tools[0].description).toBe('A test tool');
    expect(result.tools[0].category).toBe('testing');
    expect(result.tools[0].risk).toBe('low');
    expect(result.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
    expect(result.tools[0].executor).toBe('tools/run.ts');
    expect(result.tools[0].execution_target).toBe('host');
  });

  test('preserves all fields exactly', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['url'],
    };
    const raw = makeManifest({
      tools: [makeToolEntry({
        name: 'web-fetch',
        description: 'Fetch content from a URL',
        category: 'network',
        risk: 'medium',
        input_schema: schema,
        executor: 'tools/web-fetch.ts',
        execution_target: 'sandbox',
      })],
    });

    const result = parseToolManifest(raw);
    const tool = result.tools[0];

    expect(tool.name).toBe('web-fetch');
    expect(tool.description).toBe('Fetch content from a URL');
    expect(tool.category).toBe('network');
    expect(tool.risk).toBe('medium');
    expect(tool.input_schema).toEqual(schema);
    expect(tool.executor).toBe('tools/web-fetch.ts');
    expect(tool.execution_target).toBe('sandbox');
  });

  test('parses a manifest with multiple tools', () => {
    const raw = makeManifest({
      tools: [
        makeToolEntry({ name: 'tool-a', risk: 'low' }),
        makeToolEntry({ name: 'tool-b', risk: 'medium' }),
        makeToolEntry({ name: 'tool-c', risk: 'high' }),
      ],
    });

    const result = parseToolManifest(raw);
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name)).toEqual(['tool-a', 'tool-b', 'tool-c']);
    expect(result.tools.map((t) => t.risk)).toEqual(['low', 'medium', 'high']);
  });

  test('accepts executor with ./ prefix', () => {
    const raw = makeManifest({
      tools: [makeToolEntry({ executor: './tools/run.ts' })],
    });

    const result = parseToolManifest(raw);
    expect(result.tools[0].executor).toBe('./tools/run.ts');
  });

  test('accepts deeply nested executor paths', () => {
    const raw = makeManifest({
      tools: [makeToolEntry({ executor: 'src/tools/impl/run.ts' })],
    });

    const result = parseToolManifest(raw);
    expect(result.tools[0].executor).toBe('src/tools/impl/run.ts');
  });

  test('accepts all valid risk levels', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      const raw = makeManifest({
        tools: [makeToolEntry({ name: `tool-${risk}`, risk })],
      });
      const result = parseToolManifest(raw);
      expect(result.tools[0].risk).toBe(risk);
    }
  });

  test('accepts both execution targets', () => {
    for (const target of ['host', 'sandbox'] as const) {
      const raw = makeManifest({
        tools: [makeToolEntry({ name: `tool-${target}`, execution_target: target })],
      });
      const result = parseToolManifest(raw);
      expect(result.tools[0].execution_target).toBe(target);
    }
  });

  test('accepts an empty input_schema object', () => {
    const raw = makeManifest({
      tools: [makeToolEntry({ input_schema: {} })],
    });

    const result = parseToolManifest(raw);
    expect(result.tools[0].input_schema).toEqual({});
  });

  test('returns a typed SkillToolManifest', () => {
    const raw = makeManifest();
    const result: SkillToolManifest = parseToolManifest(raw);

    // Type assertion is the test — if this compiles, the return type is correct
    expect(result).toBeDefined();
    expect(result.version).toBe(1);
    expect(Array.isArray(result.tools)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseToolManifestFile — happy path
// ---------------------------------------------------------------------------

describe('parseToolManifestFile', () => {
  test('reads and parses a valid TOOLS.json file', async () => {
    const manifest = makeManifest({
      tools: [
        makeToolEntry({ name: 'file-tool', executor: 'tools/file.ts' }),
      ],
    });
    const filePath = join(tempDir, 'valid-TOOLS.json');
    await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');

    const result = parseToolManifestFile(filePath);
    expect(result.version).toBe(1);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('file-tool');
    expect(result.tools[0].executor).toBe('tools/file.ts');
  });

  test('parses a file with multiple tools', async () => {
    const manifest = makeManifest({
      tools: [
        makeToolEntry({ name: 'alpha', risk: 'low', execution_target: 'host' }),
        makeToolEntry({ name: 'beta', risk: 'high', execution_target: 'sandbox' }),
      ],
    });
    const filePath = join(tempDir, 'multi-TOOLS.json');
    await writeFile(filePath, JSON.stringify(manifest), 'utf-8');

    const result = parseToolManifestFile(filePath);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('alpha');
    expect(result.tools[1].name).toBe('beta');
  });
});
