/**
 * Mock signup server test fixture.
 *
 * A local HTTP server that simulates a realistic multi-step account signup
 * flow. Used by Playwright tests to verify browser-driven signup scenarios.
 *
 * Migrated from assistant/src/__tests__/fixtures/mock-signup-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

// ── Types ───────────────────────────────────────────────────────────

interface SignupSession {
  step: number; // 0 = not started, 1 = name done, 2 = username done, 3 = verified, 4 = captcha done
  firstName?: string;
  lastName?: string;
  username?: string;
  password?: string;
  verificationCode: string;
}

interface Account {
  username: string;
  firstName: string;
  lastName: string;
}

export interface MockSignupServer {
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  getAccounts(): Array<Account>;
  getVerificationCode(): string;
  reset(): void;
}

// ── Helpers ─────────────────────────────────────────────────────────

const TAKEN_USERNAMES = ['taken', 'admin', 'root'];

function generateVerificationCode(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000));
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function parseFormBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlPage(title: string, bodyContent: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title></head>',
    '<body>',
    bodyContent,
    '</body>',
    '</html>',
  ].join('\n');
}

function errorDiv(message: string): string {
  return '<div class="error">' + escapeHtml(message) + '</div>';
}

// ── HTML templates ──────────────────────────────────────────────────

function nameForm(error?: string): string {
  return htmlPage('Sign Up - Name', [
    '<h1>Create your account</h1>',
    error ? errorDiv(error) : '',
    '<form method="POST" action="/signup/step1">',
    '  <label for="first_name">First Name</label>',
    '  <input type="text" id="first_name" name="first_name">',
    '  <label for="last_name">Last Name</label>',
    '  <input type="text" id="last_name" name="last_name">',
    '  <button type="submit">Continue</button>',
    '</form>',
  ].join('\n'));
}

function usernameForm(error?: string): string {
  return htmlPage('Sign Up - Username', [
    '<h1>Choose a username</h1>',
    error ? errorDiv(error) : '',
    '<form method="POST" action="/signup/step2">',
    '  <label for="username">Username</label>',
    '  <input type="text" id="username" name="username">',
    '  <label for="password">Password</label>',
    '  <input type="password" id="password" name="password">',
    '  <button type="submit">Continue</button>',
    '</form>',
  ].join('\n'));
}

function verifyForm(error?: string): string {
  return htmlPage('Sign Up - Verify', [
    '<h1>Verify your identity</h1>',
    '<p>Enter the 6-digit verification code.</p>',
    error ? errorDiv(error) : '',
    '<form method="POST" action="/signup/step3">',
    '  <label for="code">Verification Code</label>',
    '  <input type="text" id="code" name="code">',
    '  <button type="submit">Verify</button>',
    '</form>',
  ].join('\n'));
}

function captchaForm(error?: string): string {
  return htmlPage('Sign Up - CAPTCHA', [
    '<h1>One last step</h1>',
    error ? errorDiv(error) : '',
    '<form method="POST" action="/signup/step4">',
    '  <div class="g-recaptcha">',
    '    <label for="captcha_solved">I am not a robot</label>',
    '    <input type="checkbox" id="captcha_solved" name="captcha_solved" value="true">',
    '  </div>',
    '  <button type="submit">Complete Sign Up</button>',
    '</form>',
  ].join('\n'));
}

function completePage(username: string): string {
  return htmlPage('Sign Up - Complete', [
    '<h1>Account created successfully!</h1>',
    '<p>Welcome, <strong>' + escapeHtml(username) + '</strong>!</p>',
  ].join('\n'));
}

// ── Server factory ──────────────────────────────────────────────────

export function createMockSignupServer(): MockSignupServer {
  let server: Server | null = null;
  let sessions = new Map<string, SignupSession>();
  let accounts: Account[] = [];
  let lastVerificationCode = '';

  function getOrCreateSession(cookieHeader: string | undefined): { session: SignupSession; id: string } {
    const cookies = parseCookies(cookieHeader);
    const existing = cookies['signup_session'];
    if (existing && sessions.has(existing)) {
      return { session: sessions.get(existing)!, id: existing };
    }
    const id = crypto.randomUUID();
    const code = generateVerificationCode();
    lastVerificationCode = code;
    const session: SignupSession = { step: 0, verificationCode: code };
    sessions.set(id, session);
    return { session, id };
  }

  function sessionCookie(id: string): string {
    return `signup_session=${id}; Path=/; HttpOnly`;
  }

  function sendRedirect(res: ServerResponse, path: string, sessionId: string): void {
    res.writeHead(302, {
      Location: path,
      'Set-Cookie': sessionCookie(sessionId),
    });
    res.end();
  }

  function sendHtml(res: ServerResponse, html: string, sessionId: string, status = 200): void {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': sessionCookie(sessionId),
    });
    res.end(html);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => resolve(data));
    });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost`);
    const path = url.pathname;
    const method = req.method || 'GET';
    const cookieHeader = req.headers.cookie;

    if (!path.startsWith('/signup')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    if (method === 'GET' && path === '/signup/verify-code') {
      const cookies = parseCookies(cookieHeader);
      const sid = cookies['signup_session'];
      const sess = sid ? sessions.get(sid) : undefined;
      const code = sess ? sess.verificationCode : lastVerificationCode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code }));
      return;
    }

    const { session, id } = getOrCreateSession(cookieHeader);

    if (method === 'GET' && path === '/signup') {
      sendHtml(res, nameForm(), id);
      return;
    }

    if (method === 'POST' && path === '/signup/step1') {
      const body = parseFormBody(await readBody(req));
      const firstName = (body['first_name'] ?? '').trim();
      const lastName = (body['last_name'] ?? '').trim();

      if (!firstName || !lastName) {
        sendHtml(res, nameForm('Both first name and last name are required.'), id, 400);
        return;
      }
      if (firstName.length > 50 || lastName.length > 50) {
        sendHtml(res, nameForm('Names must be 50 characters or fewer.'), id, 400);
        return;
      }

      session.firstName = firstName;
      session.lastName = lastName;
      session.step = 1;
      sendRedirect(res, '/signup/username', id);
      return;
    }

    if (method === 'GET' && path === '/signup/username') {
      if (session.step < 1) { sendRedirect(res, '/signup', id); return; }
      sendHtml(res, usernameForm(), id);
      return;
    }

    if (method === 'POST' && path === '/signup/step2') {
      if (session.step < 1) { sendRedirect(res, '/signup', id); return; }
      const body = parseFormBody(await readBody(req));
      const username = (body['username'] ?? '').trim();
      const password = body['password'] ?? '';

      if (!username) { sendHtml(res, usernameForm('Username is required.'), id, 400); return; }
      if (username.length < 3 || username.length > 30) { sendHtml(res, usernameForm('Username must be between 3 and 30 characters.'), id, 400); return; }
      if (!/^[a-zA-Z0-9.]+$/.test(username)) { sendHtml(res, usernameForm('Username may only contain letters, numbers, and dots.'), id, 400); return; }
      if (TAKEN_USERNAMES.includes(username.toLowerCase())) { sendHtml(res, usernameForm('Username is already taken.'), id, 400); return; }
      if (password.length < 8) { sendHtml(res, usernameForm('Password must be at least 8 characters.'), id, 400); return; }

      session.username = username;
      session.password = password;
      session.step = 2;
      sendRedirect(res, '/signup/verify', id);
      return;
    }

    if (method === 'GET' && path === '/signup/verify') {
      if (session.step < 2) { sendRedirect(res, '/signup', id); return; }
      sendHtml(res, verifyForm(), id);
      return;
    }

    if (method === 'POST' && path === '/signup/step3') {
      if (session.step < 2) { sendRedirect(res, '/signup', id); return; }
      const body = parseFormBody(await readBody(req));
      const code = (body['code'] ?? '').trim();

      if (!code) { sendHtml(res, verifyForm('Verification code is required.'), id, 400); return; }
      if (code !== session.verificationCode) { sendHtml(res, verifyForm('Invalid verification code.'), id, 400); return; }

      session.step = 3;
      sendRedirect(res, '/signup/captcha', id);
      return;
    }

    if (method === 'GET' && path === '/signup/captcha') {
      if (session.step < 3) { sendRedirect(res, '/signup', id); return; }
      sendHtml(res, captchaForm(), id);
      return;
    }

    if (method === 'POST' && path === '/signup/step4') {
      if (session.step < 3) { sendRedirect(res, '/signup', id); return; }
      if (session.step >= 4) { sendRedirect(res, '/signup/complete', id); return; }
      const body = parseFormBody(await readBody(req));
      const captchaSolved = body['captcha_solved'];

      if (captchaSolved !== 'true') { sendHtml(res, captchaForm('Please complete the CAPTCHA.'), id, 400); return; }

      session.step = 4;
      accounts.push({
        username: session.username!,
        firstName: session.firstName!,
        lastName: session.lastName!,
      });
      sendRedirect(res, '/signup/complete', id);
      return;
    }

    if (method === 'GET' && path === '/signup/complete') {
      if (session.step < 4) { sendRedirect(res, '/signup', id); return; }
      sendHtml(res, completePage(session.username!), id);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  return {
    start() {
      return new Promise((resolve) => {
        server = createServer((req, res) => {
          handleRequest(req, res).catch(() => {
            res.writeHead(500);
            res.end('Internal Server Error');
          });
        });
        server.listen(0, () => {
          const addr = server!.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve({ port, url: `http://localhost:${port}` });
        });
      });
    },

    stop() {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve());
          server = null;
        } else {
          resolve();
        }
      });
    },

    getAccounts() {
      return [...accounts];
    },

    getVerificationCode() {
      return lastVerificationCode;
    },

    reset() {
      sessions = new Map();
      accounts = [];
      lastVerificationCode = '';
    },
  };
}
