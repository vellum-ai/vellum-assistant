import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  deriveOverallRisk,
  skillsshFetchAudit,
  skillsshSearch,
  skillsshSearchWithAudit,
  type SkillsShAuditReport,
} from '../skills/skillssh.js';

// ─── Fetch mock setup ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Search adapter ─────────────────────────────────────────────────────────────

describe('skillsshSearch', () => {
  test('maps search response to typed result', async () => {
    const apiResponse = {
      query: 'youtube',
      searchType: 'fuzzy',
      skills: [
        {
          id: 'inference-sh-9/skills/youtube-thumbnail-design',
          skillId: 'youtube-thumbnail-design',
          name: 'youtube-thumbnail-design',
          installs: 1577,
          source: 'inference-sh-9/skills',
        },
        {
          id: 'some-org/skills/youtube-downloader',
          skillId: 'youtube-downloader',
          name: 'youtube-downloader',
          installs: 42,
          source: 'some-org/skills',
        },
      ],
      count: 2,
      duration_ms: 17,
    };

    mockFetch(() => new Response(JSON.stringify(apiResponse), { status: 200 }));

    const result = await skillsshSearch('youtube');

    expect(result.query).toBe('youtube');
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]).toEqual({
      id: 'inference-sh-9/skills/youtube-thumbnail-design',
      skillId: 'youtube-thumbnail-design',
      name: 'youtube-thumbnail-design',
      installs: 1577,
      source: 'inference-sh-9/skills',
    });
    expect(result.skills[1].skillId).toBe('youtube-downloader');
  });

  test('passes limit parameter to the API', async () => {
    const apiResponse = { query: 'test', skills: [], count: 0, duration_ms: 1 };
    let capturedUrl = '';

    globalThis.fetch = mock((input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(new Response(JSON.stringify(apiResponse), { status: 200 }));
    }) as unknown as typeof fetch;

    await skillsshSearch('test', { limit: 5 });

    expect(capturedUrl).toContain('limit=5');
  });

  test('throws on HTTP error', async () => {
    mockFetch(() => new Response('Internal Server Error', { status: 500 }));

    await expect(skillsshSearch('fail')).rejects.toThrow('skills.sh search failed: HTTP 500');
  });

  test('throws on malformed response (missing skills array)', async () => {
    mockFetch(() => new Response(JSON.stringify({ query: 'test' }), { status: 200 }));

    await expect(skillsshSearch('test')).rejects.toThrow(
      'skills.sh search returned unexpected response shape',
    );
  });

  test('throws on non-JSON response', async () => {
    mockFetch(() => new Response('not json', { status: 200 }));

    await expect(skillsshSearch('test')).rejects.toThrow();
  });

  test('handles missing optional fields gracefully', async () => {
    const apiResponse = {
      query: 'minimal',
      skills: [{ id: 'a/b/c' }],
      count: 1,
    };

    mockFetch(() => new Response(JSON.stringify(apiResponse), { status: 200 }));

    const result = await skillsshSearch('minimal');
    expect(result.skills[0]).toEqual({
      id: 'a/b/c',
      skillId: '',
      name: '',
      installs: 0,
      source: '',
    });
  });
});

// ─── Audit adapter ──────────────────────────────────────────────────────────────

describe('skillsshFetchAudit', () => {
  test('maps audit response with all providers', async () => {
    const apiResponse = {
      'youtube-thumbnail-design': {
        ath: {
          risk: 'safe',
          analyzedAt: '2026-02-25T17:35:40.633Z',
        },
        socket: {
          risk: 'critical',
          alerts: 1,
          score: 64,
          analyzedAt: '2026-02-25T17:38:29.066Z',
        },
        snyk: {
          risk: 'critical',
          analyzedAt: '2026-02-25T17:35:25.289525+00:00',
        },
      },
    };

    mockFetch(() => new Response(JSON.stringify(apiResponse), { status: 200 }));

    const result = await skillsshFetchAudit('inference-sh-9/skills', 'youtube-thumbnail-design');

    expect(result.ath).toEqual({
      risk: 'safe',
      analyzedAt: '2026-02-25T17:35:40.633Z',
    });
    expect(result.socket).toEqual({
      risk: 'critical',
      alerts: 1,
      score: 64,
      analyzedAt: '2026-02-25T17:38:29.066Z',
    });
    expect(result.snyk).toEqual({
      risk: 'critical',
      analyzedAt: '2026-02-25T17:35:25.289525+00:00',
    });
  });

  test('returns empty report when skill has no audit data', async () => {
    const apiResponse = { 'some-skill': {} };

    mockFetch(() => new Response(JSON.stringify(apiResponse), { status: 200 }));

    const result = await skillsshFetchAudit('org/repo', 'some-skill');

    expect(result).toEqual({});
  });

  test('returns empty report when skill is not in response', async () => {
    const apiResponse = { 'other-skill': { ath: { risk: 'safe', analyzedAt: '2026-01-01T00:00:00Z' } } };

    mockFetch(() => new Response(JSON.stringify(apiResponse), { status: 200 }));

    const result = await skillsshFetchAudit('org/repo', 'missing-skill');

    expect(result).toEqual({});
  });

  test('throws on HTTP error', async () => {
    mockFetch(() => new Response('Bad Request', { status: 400 }));

    await expect(skillsshFetchAudit('org/repo', 'skill')).rejects.toThrow(
      'skills.sh audit failed: HTTP 400',
    );
  });

  test('throws on non-object response', async () => {
    mockFetch(() => new Response('"string"', { status: 200 }));

    await expect(skillsshFetchAudit('org/repo', 'skill')).rejects.toThrow(
      'skills.sh audit returned unexpected response shape',
    );
  });

  test('only includes numeric alerts and score fields', async () => {
    const apiResponse = {
      'test-skill': {
        socket: {
          risk: 'low',
          analyzedAt: '2026-01-01T00:00:00Z',
          alerts: 'not-a-number',
          score: 'also-not',
        },
      },
    };

    mockFetch(() => new Response(JSON.stringify(apiResponse), { status: 200 }));

    const result = await skillsshFetchAudit('org/repo', 'test-skill');

    expect(result.socket).toEqual({
      risk: 'low',
      analyzedAt: '2026-01-01T00:00:00Z',
    });
    // alerts and score should NOT be present since they weren't numeric
    expect(result.socket!.alerts).toBeUndefined();
    expect(result.socket!.score).toBeUndefined();
  });
});

// ─── Risk derivation ────────────────────────────────────────────────────────────

describe('deriveOverallRisk', () => {
  test('returns unknown when no dimensions exist', () => {
    expect(deriveOverallRisk({})).toBe('unknown');
  });

  test('returns safe when all dimensions are safe', () => {
    const audit: SkillsShAuditReport = {
      ath: { risk: 'safe', analyzedAt: '' },
      socket: { risk: 'safe', analyzedAt: '' },
      snyk: { risk: 'safe', analyzedAt: '' },
    };
    expect(deriveOverallRisk(audit)).toBe('safe');
  });

  test('returns worst-case risk across dimensions', () => {
    const audit: SkillsShAuditReport = {
      ath: { risk: 'safe', analyzedAt: '' },
      socket: { risk: 'critical', analyzedAt: '' },
      snyk: { risk: 'low', analyzedAt: '' },
    };
    expect(deriveOverallRisk(audit)).toBe('critical');
  });

  test('returns medium when that is the highest', () => {
    const audit: SkillsShAuditReport = {
      ath: { risk: 'low', analyzedAt: '' },
      snyk: { risk: 'medium', analyzedAt: '' },
    };
    expect(deriveOverallRisk(audit)).toBe('medium');
  });

  test('handles single dimension', () => {
    const audit: SkillsShAuditReport = {
      ath: { risk: 'high', analyzedAt: '' },
    };
    expect(deriveOverallRisk(audit)).toBe('high');
  });

  test('returns unknown for unrecognized risk labels (fail closed)', () => {
    const audit: SkillsShAuditReport = {
      ath: { risk: 'safe', analyzedAt: '' },
      socket: { risk: 'super-dangerous' as string, analyzedAt: '' },
    };
    expect(deriveOverallRisk(audit)).toBe('unknown');
  });
});

// ─── Combined search + audit ────────────────────────────────────────────────────

describe('skillsshSearchWithAudit', () => {
  test('combines search results with audit data', async () => {
    mockFetch((url: string) => {
      if (url.includes('skills.sh/api/search')) {
        return new Response(
          JSON.stringify({
            query: 'test',
            skills: [
              {
                id: 'org/skills/my-skill',
                skillId: 'my-skill',
                name: 'my-skill',
                installs: 100,
                source: 'org/skills',
              },
            ],
            count: 1,
          }),
          { status: 200 },
        );
      }

      if (url.includes('add-skill.vercel.sh/audit')) {
        return new Response(
          JSON.stringify({
            'my-skill': {
              ath: { risk: 'safe', analyzedAt: '2026-01-01T00:00:00Z' },
              socket: { risk: 'low', analyzedAt: '2026-01-01T00:00:00Z', alerts: 0, score: 90 },
            },
          }),
          { status: 200 },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    const result = await skillsshSearchWithAudit('test');

    expect(result.query).toBe('test');
    expect(result.skills).toHaveLength(1);

    const skill = result.skills[0];
    expect(skill.skillId).toBe('my-skill');
    expect(skill.overallRisk).toBe('low');
    expect(skill.audit.ath?.risk).toBe('safe');
    expect(skill.audit.socket?.risk).toBe('low');
    expect(skill.audit.socket?.alerts).toBe(0);
    expect(skill.audit.socket?.score).toBe(90);
  });

  test('treats failed audit fetch as unknown risk', async () => {
    mockFetch((url: string) => {
      if (url.includes('skills.sh/api/search')) {
        return new Response(
          JSON.stringify({
            query: 'test',
            skills: [
              {
                id: 'org/skills/my-skill',
                skillId: 'my-skill',
                name: 'my-skill',
                installs: 50,
                source: 'org/skills',
              },
            ],
            count: 1,
          }),
          { status: 200 },
        );
      }

      // Audit API returns 500
      return new Response('Server Error', { status: 500 });
    });

    const result = await skillsshSearchWithAudit('test');

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].overallRisk).toBe('unknown');
    expect(result.skills[0].audit).toEqual({});
  });

  test('handles multiple skills with mixed audit results', async () => {
    let auditCallCount = 0;

    mockFetch((url: string) => {
      if (url.includes('skills.sh/api/search')) {
        return new Response(
          JSON.stringify({
            query: 'multi',
            skills: [
              { id: 'a/skills/s1', skillId: 's1', name: 's1', installs: 10, source: 'a/skills' },
              { id: 'b/skills/s2', skillId: 's2', name: 's2', installs: 20, source: 'b/skills' },
            ],
            count: 2,
          }),
          { status: 200 },
        );
      }

      auditCallCount++;
      // First audit succeeds, second fails
      if (url.includes('skills=s1')) {
        return new Response(
          JSON.stringify({
            s1: { ath: { risk: 'safe', analyzedAt: '2026-01-01T00:00:00Z' } },
          }),
          { status: 200 },
        );
      }

      return new Response('Timeout', { status: 504 });
    });

    const result = await skillsshSearchWithAudit('multi');

    expect(result.skills).toHaveLength(2);
    expect(result.skills[0].overallRisk).toBe('safe');
    expect(result.skills[1].overallRisk).toBe('unknown');
  });
});
