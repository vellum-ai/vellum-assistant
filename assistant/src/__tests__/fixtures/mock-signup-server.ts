/**
 * Mock signup server test fixture.
 *
 * A local Bun HTTP server that simulates a realistic multi-step account signup
 * flow. Used by integration tests to verify account-setup tools.
 */

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

const TAKEN_USERNAMES = ["taken", "admin", "root"];

function generateVerificationCode(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000));
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eqIdx = pair.indexOf("=");
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

function htmlPage(title: string, bodyContent: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>' +
      escapeHtml(title) +
      "</title></head>",
    "<body>",
    bodyContent,
    "</body>",
    "</html>",
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorDiv(message: string): string {
  return '<div class="error">' + escapeHtml(message) + "</div>";
}

// ── HTML templates ──────────────────────────────────────────────────

function nameForm(error?: string): string {
  return htmlPage(
    "Sign Up - Name",
    [
      "<h1>Create your account</h1>",
      error ? errorDiv(error) : "",
      '<form method="POST" action="/signup/step1">',
      '  <label for="first_name">First Name</label>',
      '  <input type="text" id="first_name" name="first_name">',
      '  <label for="last_name">Last Name</label>',
      '  <input type="text" id="last_name" name="last_name">',
      '  <button type="submit">Continue</button>',
      "</form>",
    ].join("\n"),
  );
}

function usernameForm(error?: string): string {
  return htmlPage(
    "Sign Up - Username",
    [
      "<h1>Choose a username</h1>",
      error ? errorDiv(error) : "",
      '<form method="POST" action="/signup/step2">',
      '  <label for="username">Username</label>',
      '  <input type="text" id="username" name="username">',
      '  <label for="password">Password</label>',
      '  <input type="password" id="password" name="password">',
      '  <button type="submit">Continue</button>',
      "</form>",
    ].join("\n"),
  );
}

function verifyForm(error?: string): string {
  return htmlPage(
    "Sign Up - Verify",
    [
      "<h1>Verify your identity</h1>",
      "<p>Enter the 6-digit verification code.</p>",
      error ? errorDiv(error) : "",
      '<form method="POST" action="/signup/step3">',
      '  <label for="code">Verification Code</label>',
      '  <input type="text" id="code" name="code">',
      '  <button type="submit">Verify</button>',
      "</form>",
    ].join("\n"),
  );
}

function captchaForm(error?: string): string {
  return htmlPage(
    "Sign Up - CAPTCHA",
    [
      "<h1>One last step</h1>",
      error ? errorDiv(error) : "",
      '<form method="POST" action="/signup/step4">',
      '  <div class="g-recaptcha">',
      '    <label for="captcha_solved">I am not a robot</label>',
      '    <input type="checkbox" id="captcha_solved" name="captcha_solved" value="true">',
      "  </div>",
      '  <button type="submit">Complete Sign Up</button>',
      "</form>",
    ].join("\n"),
  );
}

function completePage(username: string): string {
  return htmlPage(
    "Sign Up - Complete",
    [
      "<h1>Account created successfully!</h1>",
      "<p>Welcome, <strong>" + escapeHtml(username) + "</strong>!</p>",
    ].join("\n"),
  );
}

// ── Server factory ──────────────────────────────────────────────────

export function createMockSignupServer(): MockSignupServer {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let sessions = new Map<string, SignupSession>();
  let accounts: Account[] = [];
  /** Stores the most recently generated verification code (for the test-only endpoint). */
  let lastVerificationCode = "";

  function getOrCreateConversation(cookieHeader: string | null): {
    session: SignupSession;
    id: string;
  } {
    const cookies = parseCookies(cookieHeader);
    const existing = cookies["signup_session"];
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

  function redirect(path: string, sessionId: string): Response {
    return new Response(null, {
      status: 302,
      headers: {
        Location: path,
        "Set-Cookie": sessionCookie(sessionId),
      },
    });
  }

  function htmlResponse(
    html: string,
    sessionId: string,
    status = 200,
  ): Response {
    return new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": sessionCookie(sessionId),
      },
    });
  }

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const cookieHeader = req.headers.get("cookie");

    // ── Early 404 for non-signup paths ────────────────────────────
    // Avoid creating orphaned sessions for requests to unknown routes.
    if (!path.startsWith("/signup")) {
      return new Response("Not Found", { status: 404 });
    }

    // ── Test-only endpoint ────────────────────────────────────────
    // Returns the verification code for the caller's session (looked up
    // via the session cookie) so parallel / multi-session tests work.
    if (method === "GET" && path === "/signup/verify-code") {
      const cookies = parseCookies(cookieHeader);
      const sid = cookies["signup_session"];
      const sess = sid ? sessions.get(sid) : undefined;
      const code = sess ? sess.verificationCode : lastVerificationCode;
      return new Response(JSON.stringify({ code }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { session, id } = getOrCreateConversation(cookieHeader);

    // ── Step 1: Name form ─────────────────────────────────────────
    if (method === "GET" && path === "/signup") {
      return htmlResponse(nameForm(), id);
    }

    if (method === "POST" && path === "/signup/step1") {
      const body = parseFormBody(await req.text());
      const firstName = (body["first_name"] ?? "").trim();
      const lastName = (body["last_name"] ?? "").trim();

      if (!firstName || !lastName) {
        return htmlResponse(
          nameForm("Both first name and last name are required."),
          id,
          400,
        );
      }
      if (firstName.length > 50 || lastName.length > 50) {
        return htmlResponse(
          nameForm("Names must be 50 characters or fewer."),
          id,
          400,
        );
      }

      session.firstName = firstName;
      session.lastName = lastName;
      session.step = 1;
      return redirect("/signup/username", id);
    }

    // ── Step 2: Username / password form ──────────────────────────
    if (method === "GET" && path === "/signup/username") {
      if (session.step < 1) {
        return redirect("/signup", id);
      }
      return htmlResponse(usernameForm(), id);
    }

    if (method === "POST" && path === "/signup/step2") {
      if (session.step < 1) {
        return redirect("/signup", id);
      }
      const body = parseFormBody(await req.text());
      const username = (body["username"] ?? "").trim();
      const password = body["password"] ?? "";

      if (!username) {
        return htmlResponse(usernameForm("Username is required."), id, 400);
      }
      if (username.length < 3 || username.length > 30) {
        return htmlResponse(
          usernameForm("Username must be between 3 and 30 characters."),
          id,
          400,
        );
      }
      if (!/^[a-zA-Z0-9.]+$/.test(username)) {
        return htmlResponse(
          usernameForm("Username may only contain letters, numbers, and dots."),
          id,
          400,
        );
      }
      if (TAKEN_USERNAMES.includes(username.toLowerCase())) {
        return htmlResponse(
          usernameForm("Username is already taken."),
          id,
          400,
        );
      }
      if (password.length < 8) {
        return htmlResponse(
          usernameForm("Password must be at least 8 characters."),
          id,
          400,
        );
      }

      session.username = username;
      session.password = password;
      session.step = 2;
      return redirect("/signup/verify", id);
    }

    // ── Step 3: Verification code ─────────────────────────────────
    if (method === "GET" && path === "/signup/verify") {
      if (session.step < 2) {
        return redirect("/signup", id);
      }
      return htmlResponse(verifyForm(), id);
    }

    if (method === "POST" && path === "/signup/step3") {
      if (session.step < 2) {
        return redirect("/signup", id);
      }
      const body = parseFormBody(await req.text());
      const code = (body["code"] ?? "").trim();

      if (!code) {
        return htmlResponse(
          verifyForm("Verification code is required."),
          id,
          400,
        );
      }
      if (code !== session.verificationCode) {
        return htmlResponse(verifyForm("Invalid verification code."), id, 400);
      }

      session.step = 3;
      return redirect("/signup/captcha", id);
    }

    // ── Step 4: CAPTCHA ───────────────────────────────────────────
    if (method === "GET" && path === "/signup/captcha") {
      if (session.step < 3) {
        return redirect("/signup", id);
      }
      return htmlResponse(captchaForm(), id);
    }

    if (method === "POST" && path === "/signup/step4") {
      if (session.step < 3) {
        return redirect("/signup", id);
      }
      // Guard: if already completed, redirect to the completion page
      // instead of creating a duplicate account.
      if (session.step >= 4) {
        return redirect("/signup/complete", id);
      }
      const body = parseFormBody(await req.text());
      const captchaSolved = body["captcha_solved"];

      if (captchaSolved !== "true") {
        return htmlResponse(
          captchaForm("Please complete the CAPTCHA."),
          id,
          400,
        );
      }

      session.step = 4;
      accounts.push({
        username: session.username!,
        firstName: session.firstName!,
        lastName: session.lastName!,
      });
      return redirect("/signup/complete", id);
    }

    // ── Complete page ─────────────────────────────────────────────
    if (method === "GET" && path === "/signup/complete") {
      if (session.step < 4) {
        return redirect("/signup", id);
      }
      return htmlResponse(completePage(session.username!), id);
    }

    return new Response("Not Found", { status: 404 });
  }

  return {
    async start() {
      server = Bun.serve({
        port: 0,
        fetch: handleRequest,
      });
      const port = server.port as number;
      return { port, url: `http://localhost:${port}` };
    },

    async stop() {
      if (server) {
        server.stop(true);
        server = null;
      }
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
      lastVerificationCode = "";
    },
  };
}
