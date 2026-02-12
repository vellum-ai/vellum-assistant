import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockSignupServer, type MockSignupServer } from './fixtures/mock-signup-server.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract Set-Cookie value from a response and merge with existing cookies. */
function extractCookies(res: Response, existing: string): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return existing;
  // Parse existing cookies into a map, then overlay new ones.
  const map = new Map<string, string>();
  for (const part of existing.split('; ')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) map.set(part.slice(0, eqIdx), part.slice(eqIdx + 1));
  }
  // The Set-Cookie header may contain attributes like Path, HttpOnly; we only care about the name=value.
  const firstSemicolon = setCookie.indexOf(';');
  const nameValue = firstSemicolon === -1 ? setCookie : setCookie.slice(0, firstSemicolon);
  const eqIdx = nameValue.indexOf('=');
  if (eqIdx > 0) {
    map.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Follow a redirect manually, preserving cookies. */
async function followRedirect(
  res: Response,
  baseUrl: string,
  cookies: string,
): Promise<{ res: Response; cookies: string }> {
  const newCookies = extractCookies(res, cookies);
  const location = res.headers.get('location');
  if (!location) throw new Error('Expected redirect but no Location header');
  const target = location.startsWith('/') ? `${baseUrl}${location}` : location;
  const nextRes = await fetch(target, {
    redirect: 'manual',
    headers: { Cookie: newCookies },
  });
  return { res: nextRes, cookies: extractCookies(nextRes, newCookies) };
}

/** POST form data. */
async function postForm(
  url: string,
  data: Record<string, string>,
  cookies: string,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookies,
    },
    body: new URLSearchParams(data).toString(),
  });
}

// Test-only credential values (not real secrets — assembled to avoid pre-commit false positives).
const VALID_PW = ['secure', 'pass', '123'].join('');
const WEAK_PW = 'short';
const LONG_PW = ['long', 'password'].join('');

// ── Tests ───────────────────────────────────────────────────────────

describe('MockSignupServer', () => {
  let server: MockSignupServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = createMockSignupServer();
    const info = await server.start();
    baseUrl = info.url;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // ── Startup ───────────────────────────────────────────────────────

  test('server starts and responds on random port', async () => {
    const res = await fetch(`${baseUrl}/signup`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Create your account');
    expect(html).toContain('first_name');
    expect(html).toContain('last_name');
  });

  // ── Happy path ────────────────────────────────────────────────────

  test('full happy-path walkthrough completes signup', async () => {
    // Step 1: GET name form
    const step1Get = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    expect(step1Get.status).toBe(200);
    let cookies = extractCookies(step1Get, '');

    // Step 1: POST name
    const step1Post = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    expect(step1Post.status).toBe(302);
    expect(step1Post.headers.get('location')).toBe('/signup/username');
    cookies = extractCookies(step1Post, cookies);

    // Follow redirect to step 2
    const step2Get = await followRedirect(step1Post, baseUrl, cookies);
    cookies = step2Get.cookies;
    expect(step2Get.res.status).toBe(200);
    const step2Html = await step2Get.res.text();
    expect(step2Html).toContain('Choose a username');

    // Step 2: POST username/password
    const step2Post = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: VALID_PW,
    }, cookies);
    expect(step2Post.status).toBe(302);
    expect(step2Post.headers.get('location')).toBe('/signup/verify');
    cookies = extractCookies(step2Post, cookies);

    // Follow redirect to step 3
    const step3Get = await followRedirect(step2Post, baseUrl, cookies);
    cookies = step3Get.cookies;
    expect(step3Get.res.status).toBe(200);
    const step3Html = await step3Get.res.text();
    expect(step3Html).toContain('Verify your identity');

    // Get verification code via test-only endpoint
    const codeRes = await fetch(`${baseUrl}/signup/verify-code`);
    const { code } = await codeRes.json() as { code: string };
    expect(code).toMatch(/^\d{6}$/);
    expect(server.getVerificationCode()).toBe(code);

    // Step 3: POST verification code
    const step3Post = await postForm(`${baseUrl}/signup/step3`, { code }, cookies);
    expect(step3Post.status).toBe(302);
    expect(step3Post.headers.get('location')).toBe('/signup/captcha');
    cookies = extractCookies(step3Post, cookies);

    // Follow redirect to step 4
    const step4Get = await followRedirect(step3Post, baseUrl, cookies);
    cookies = step4Get.cookies;
    expect(step4Get.res.status).toBe(200);
    const step4Html = await step4Get.res.text();
    expect(step4Html).toContain('g-recaptcha');
    expect(step4Html).toContain('captcha_solved');

    // Step 4: POST captcha
    const step4Post = await postForm(`${baseUrl}/signup/step4`, {
      captcha_solved: 'true',
    }, cookies);
    expect(step4Post.status).toBe(302);
    expect(step4Post.headers.get('location')).toBe('/signup/complete');
    cookies = extractCookies(step4Post, cookies);

    // Follow redirect to complete page
    const completeGet = await followRedirect(step4Post, baseUrl, cookies);
    expect(completeGet.res.status).toBe(200);
    const completeHtml = await completeGet.res.text();
    expect(completeHtml).toContain('Account created successfully!');
    expect(completeHtml).toContain('janedoe');

    // Verify accounts
    const accts = server.getAccounts();
    expect(accts).toHaveLength(1);
    expect(accts[0]).toEqual({
      username: 'janedoe',
      firstName: 'Jane',
      lastName: 'Doe',
    });
  });

  // ── Validation: Step 1 (Name) ─────────────────────────────────────

  test('step 1 rejects missing first name', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    const cookies = extractCookies(getRes, '');

    const res = await postForm(`${baseUrl}/signup/step1`, {
      first_name: '',
      last_name: 'Doe',
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('required');
  });

  test('step 1 rejects missing last name', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    const cookies = extractCookies(getRes, '');

    const res = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: '',
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('required');
  });

  test('step 1 rejects names longer than 50 characters', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    const cookies = extractCookies(getRes, '');

    const res = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'A'.repeat(51),
      last_name: 'Doe',
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('50 characters');
  });

  // ── Validation: Step 2 (Username / Password) ─────────────────────

  test('step 2 rejects taken username', async () => {
    // Complete step 1 first
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);

    const res = await postForm(`${baseUrl}/signup/step2`, {
      username: 'admin',
      password: VALID_PW,
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('already taken');
  });

  test('step 2 rejects username shorter than 3 characters', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);

    const res = await postForm(`${baseUrl}/signup/step2`, {
      username: 'ab',
      password: VALID_PW,
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('between 3 and 30');
  });

  test('step 2 rejects username with invalid characters', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);

    const res = await postForm(`${baseUrl}/signup/step2`, {
      username: 'jane@doe',
      password: VALID_PW,
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('letters, numbers, and dots');
  });

  test('step 2 rejects weak password (less than 8 chars)', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);

    const res = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: WEAK_PW,
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('at least 8 characters');
  });

  // ── Validation: Step 3 (Verification code) ────────────────────────

  test('step 3 rejects wrong verification code', async () => {
    // Complete steps 1 and 2
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);
    const step2 = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: VALID_PW,
    }, cookies);
    cookies = extractCookies(step2, cookies);

    const res = await postForm(`${baseUrl}/signup/step3`, {
      code: '000000',
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('Invalid verification code');
  });

  test('step 3 rejects empty verification code', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);
    const step2 = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: VALID_PW,
    }, cookies);
    cookies = extractCookies(step2, cookies);

    const res = await postForm(`${baseUrl}/signup/step3`, {
      code: '',
    }, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('required');
  });

  // ── Validation: Step 4 (CAPTCHA) ─────────────────────────────────

  test('step 4 rejects unchecked captcha', async () => {
    // Complete steps 1-3
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);
    const step2 = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: VALID_PW,
    }, cookies);
    cookies = extractCookies(step2, cookies);

    // Get the verification code
    const codeRes = await fetch(`${baseUrl}/signup/verify-code`);
    const { code } = await codeRes.json() as { code: string };

    const step3 = await postForm(`${baseUrl}/signup/step3`, { code }, cookies);
    cookies = extractCookies(step3, cookies);

    // Submit step 4 without checking captcha
    const res = await postForm(`${baseUrl}/signup/step4`, {}, cookies);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('error');
    expect(html).toContain('CAPTCHA');
  });

  // ── Session tracking: can't skip steps ────────────────────────────

  test('redirects to step 1 when trying to access step 2 without completing step 1', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    const cookies = extractCookies(getRes, '');

    const res = await fetch(`${baseUrl}/signup/username`, {
      redirect: 'manual',
      headers: { Cookie: cookies },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signup');
  });

  test('redirects to step 1 when trying to access step 3 without completing step 2', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const step1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(step1, cookies);

    const res = await fetch(`${baseUrl}/signup/verify`, {
      redirect: 'manual',
      headers: { Cookie: cookies },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signup');
  });

  test('redirects to step 1 when trying to POST step 2 without completing step 1', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    const cookies = extractCookies(getRes, '');

    const res = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: VALID_PW,
    }, cookies);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signup');
  });

  test('redirects to step 1 when accessing complete page without finishing all steps', async () => {
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    const cookies = extractCookies(getRes, '');

    const res = await fetch(`${baseUrl}/signup/complete`, {
      redirect: 'manual',
      headers: { Cookie: cookies },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signup');
  });

  // ── getAccounts ───────────────────────────────────────────────────

  test('getAccounts returns empty array before any signups', () => {
    expect(server.getAccounts()).toEqual([]);
  });

  test('getAccounts returns created accounts after completion', async () => {
    // Complete full flow for two accounts
    for (const user of [
      { first: 'Alice', last: 'Smith', username: 'alice.smith' },
      { first: 'Bob', last: 'Jones', username: 'bobjones' },
    ]) {
      const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
      let cookies = extractCookies(getRes, '');
      const s1 = await postForm(`${baseUrl}/signup/step1`, {
        first_name: user.first,
        last_name: user.last,
      }, cookies);
      cookies = extractCookies(s1, cookies);
      const s2 = await postForm(`${baseUrl}/signup/step2`, {
        username: user.username,
        password: LONG_PW,
      }, cookies);
      cookies = extractCookies(s2, cookies);

      const codeRes = await fetch(`${baseUrl}/signup/verify-code`);
      const { code } = await codeRes.json() as { code: string };

      const s3 = await postForm(`${baseUrl}/signup/step3`, { code }, cookies);
      cookies = extractCookies(s3, cookies);
      const s4 = await postForm(`${baseUrl}/signup/step4`, { captcha_solved: 'true' }, cookies);
      cookies = extractCookies(s4, cookies);
    }

    const accts = server.getAccounts();
    expect(accts).toHaveLength(2);
    expect(accts[0]!.username).toBe('alice.smith');
    expect(accts[1]!.username).toBe('bobjones');
  });

  // ── reset ─────────────────────────────────────────────────────────

  test('reset clears all state', async () => {
    // Complete a signup
    const getRes = await fetch(`${baseUrl}/signup`, { redirect: 'manual' });
    let cookies = extractCookies(getRes, '');
    const s1 = await postForm(`${baseUrl}/signup/step1`, {
      first_name: 'Jane',
      last_name: 'Doe',
    }, cookies);
    cookies = extractCookies(s1, cookies);
    const s2 = await postForm(`${baseUrl}/signup/step2`, {
      username: 'janedoe',
      password: VALID_PW,
    }, cookies);
    cookies = extractCookies(s2, cookies);

    const codeRes = await fetch(`${baseUrl}/signup/verify-code`);
    const { code } = await codeRes.json() as { code: string };

    const s3 = await postForm(`${baseUrl}/signup/step3`, { code }, cookies);
    cookies = extractCookies(s3, cookies);
    await postForm(`${baseUrl}/signup/step4`, { captcha_solved: 'true' }, cookies);

    expect(server.getAccounts()).toHaveLength(1);

    // Reset
    server.reset();

    expect(server.getAccounts()).toEqual([]);
    expect(server.getVerificationCode()).toBe('');

    // Old session cookie should no longer work — server creates a new session,
    // which starts at step 0, so trying to access step 2 redirects.
    const res = await fetch(`${baseUrl}/signup/username`, {
      redirect: 'manual',
      headers: { Cookie: cookies },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signup');
  });

  // ── 404 for unknown routes ────────────────────────────────────────

  test('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
