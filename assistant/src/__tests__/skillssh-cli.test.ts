import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { createCli } from '../skills/skillssh-cli.js';

// ─── Fetch mock setup ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

let stdoutOutput = '';
let stderrOutput = '';

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
}

function captureOutput(): void {
  stdoutOutput = '';
  stderrOutput = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutOutput += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = undefined;
  stdoutOutput = '';
  stderrOutput = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = undefined;
});

// ─── Shared test data ────────────────────────────────────────────────────────────

function makeSearchApiResponse() {
  return {
    query: 'youtube',
    skills: [
      {
        id: 'inference-sh-9/skills/youtube-thumbnail-design',
        skillId: 'youtube-thumbnail-design',
        name: 'youtube-thumbnail-design',
        installs: 1577,
        source: 'inference-sh-9/skills',
      },
    ],
    count: 1,
    duration_ms: 17,
  };
}

function makeAuditApiResponse(skillId: string, risk = 'safe') {
  return {
    [skillId]: {
      ath: { risk, analyzedAt: '2026-02-25T17:35:40.633Z' },
      socket: { risk, analyzedAt: '2026-02-25T17:38:29.066Z', alerts: 0, score: 95 },
    },
  };
}

function makeCombinedFetchHandler(
  searchResponse: object,
  auditResponses: Record<string, object>,
) {
  return (url: string) => {
    if (url.includes('skills.sh/api/search')) {
      return new Response(JSON.stringify(searchResponse), { status: 200 });
    }
    if (url.includes('add-skill.vercel.sh/audit')) {
      // Extract the skills param to find the right audit response
      const parsedUrl = new URL(url);
      const skillParam = parsedUrl.searchParams.get('skills') ?? '';
      const auditData = auditResponses[skillParam] ?? {};
      return new Response(JSON.stringify(auditData), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  };
}

// ─── Search command ──────────────────────────────────────────────────────────────

describe('search command', () => {
  test('outputs formatted search results', async () => {
    const searchResp = makeSearchApiResponse();
    const auditResp = {
      'youtube-thumbnail-design': makeAuditApiResponse('youtube-thumbnail-design')['youtube-thumbnail-design'],
    };

    mockFetch(makeCombinedFetchHandler(searchResp, { 'youtube-thumbnail-design': auditResp }));
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'search', 'youtube', '--limit', '5']);

    expect(stdoutOutput).toContain('Found 1 skill(s)');
    expect(stdoutOutput).toContain('youtube-thumbnail-design');
    expect(stdoutOutput).toContain('[SAFE]');
    expect(stdoutOutput).toContain('1577');
  });

  test('outputs JSON when --json flag is set', async () => {
    const searchResp = makeSearchApiResponse();
    const auditResp = {
      'youtube-thumbnail-design': makeAuditApiResponse('youtube-thumbnail-design')['youtube-thumbnail-design'],
    };

    mockFetch(makeCombinedFetchHandler(searchResp, { 'youtube-thumbnail-design': auditResp }));
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'search', 'youtube', '--json']);

    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.query).toBe('youtube');
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].skillId).toBe('youtube-thumbnail-design');
    expect(parsed.skills[0].overallRisk).toBe('safe');
  });

  test('shows "no skills found" for empty results', async () => {
    mockFetch((url) => {
      if (url.includes('skills.sh/api/search')) {
        return new Response(JSON.stringify({ query: 'nonexistent', skills: [], count: 0 }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'search', 'nonexistent']);

    expect(stdoutOutput).toContain('No skills found');
  });

  test('reports errors to stderr', async () => {
    mockFetch(() => new Response('Internal Server Error', { status: 500 }));
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'search', 'fail']);

    expect(stderrOutput).toContain('Error:');
    expect(process.exitCode).toBe(1);
  });
});

// ─── Evaluate command ────────────────────────────────────────────────────────────

describe('evaluate command', () => {
  test('outputs formatted security decision for safe skill', async () => {
    mockFetch((url) => {
      if (url.includes('add-skill.vercel.sh/audit')) {
        return new Response(
          JSON.stringify(makeAuditApiResponse('my-skill')),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'evaluate', 'org/repo', 'my-skill']);

    expect(stdoutOutput).toContain('Security evaluation for org/repo/my-skill');
    expect(stdoutOutput).toContain('proceed');
    expect(stdoutOutput).toContain('[SAFE]');
  });

  test('outputs do_not_recommend for critical risk', async () => {
    mockFetch((url) => {
      if (url.includes('add-skill.vercel.sh/audit')) {
        return new Response(
          JSON.stringify({
            'risky-skill': {
              ath: { risk: 'safe', analyzedAt: '2026-01-01T00:00:00Z' },
              snyk: { risk: 'critical', analyzedAt: '2026-01-01T00:00:00Z', alerts: 5 },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'evaluate', 'org/repo', 'risky-skill']);

    expect(stdoutOutput).toContain('do_not_recommend');
    expect(stdoutOutput).toContain('[CRITICAL]');
    expect(stdoutOutput).toContain('Snyk');
  });

  test('outputs JSON when --json flag is set', async () => {
    mockFetch((url) => {
      if (url.includes('add-skill.vercel.sh/audit')) {
        return new Response(
          JSON.stringify(makeAuditApiResponse('my-skill')),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'evaluate', 'org/repo', 'my-skill', '--json']);

    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.recommendation).toBe('proceed');
    expect(parsed.overallRisk).toBe('safe');
    expect(parsed.auditSummary).toBeArray();
  });

  test('reports fetch errors', async () => {
    mockFetch(() => new Response('Server Error', { status: 500 }));
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'evaluate', 'org/repo', 'my-skill']);

    expect(stderrOutput).toContain('Error:');
    expect(process.exitCode).toBe(1);
  });
});

// ─── Install command ─────────────────────────────────────────────────────────────

describe('install command', () => {
  test('reports error when security check blocks installation', async () => {
    mockFetch((url) => {
      if (url.includes('add-skill.vercel.sh/audit')) {
        return new Response(
          JSON.stringify({
            'dangerous-skill': {
              snyk: { risk: 'critical', analyzedAt: '2026-01-01T00:00:00Z' },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'install', 'org/repo', 'dangerous-skill']);

    expect(stderrOutput).toContain('Installation failed');
    expect(stderrOutput).toContain('do_not_recommend');
    expect(process.exitCode).toBe(1);
  });

  test('reports error in JSON mode when security check blocks', async () => {
    mockFetch((url) => {
      if (url.includes('add-skill.vercel.sh/audit')) {
        return new Response(
          JSON.stringify({
            'dangerous-skill': {
              snyk: { risk: 'critical', analyzedAt: '2026-01-01T00:00:00Z' },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'install', 'org/repo', 'dangerous-skill', '--json']);

    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('do_not_recommend');
    expect(process.exitCode).toBe(1);
  });

  test('reports fetch errors', async () => {
    mockFetch(() => new Response('Server Error', { status: 500 }));
    captureOutput();

    const cli = createCli();
    await cli.parseAsync(['node', 'skillssh-cli', 'install', 'org/repo', 'my-skill']);

    expect(stderrOutput).toContain('Error:');
    expect(process.exitCode).toBe(1);
  });
});
