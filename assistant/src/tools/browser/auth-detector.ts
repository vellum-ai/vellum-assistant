import {
  evaluateExpression,
  getCurrentUrl,
} from "./cdp-client/cdp-dom-helpers.js";
import type { CdpClient } from "./cdp-client/types.js";

export type AuthChallengeType = "login" | "2fa" | "oauth_consent" | "captcha";

export interface AuthField {
  type: "email" | "password" | "code" | "approval";
  selector: string;
  label: string;
}

export interface AuthChallenge {
  type: AuthChallengeType;
  service?: string;
  fields: AuthField[];
  url: string;
}

// ── URL pattern matching ─────────────────────────────────────────────

interface ServicePattern {
  pattern: RegExp;
  service: string;
  /** When set, the URL pathname must also match this pattern for the service to be recognised. */
  pathPattern?: RegExp;
}

const SERVICE_PATTERNS: ServicePattern[] = [
  // Auth-subdomain services - hostname match is sufficient
  { pattern: /accounts\.google\.com/, service: "Google" },
  { pattern: /login\.microsoftonline\.com/, service: "Microsoft" },
  { pattern: /appleid\.apple\.com/, service: "Apple" },
  { pattern: /login\.salesforce\.com/, service: "Salesforce" },
  { pattern: /id\.atlassian\.com/, service: "Atlassian" },
  { pattern: /auth0\.com/, service: "Auth0" },
  { pattern: /okta\.com/, service: "Okta" },
  // General-domain services - need both hostname AND path match
  {
    pattern: /github\.com/,
    service: "GitHub",
    pathPattern: /^\/(login|session)/,
  },
];

const GENERIC_AUTH_PATTERNS: RegExp[] = [
  /\/login\b/i,
  /\/signin\b/i,
  /\/sign-in\b/i,
  /\/auth\b/i,
  /\/oauth\b/i,
  /\/sso\b/i,
];

/**
 * Identify the service name from a URL. Returns undefined if no known
 * service is matched.
 */
export function identifyService(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  for (const { pattern, service, pathPattern } of SERVICE_PATTERNS) {
    if (pattern.test(parsed.hostname)) {
      if (pathPattern && !pathPattern.test(parsed.pathname)) continue;
      return service;
    }
  }
  return undefined;
}

/**
 * Check whether a URL matches a known auth-related path pattern.
 */
export function isAuthUrl(url: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }
  // Known service URLs are always auth-related (respecting pathPattern when present)
  if (
    SERVICE_PATTERNS.some(
      ({ pattern, pathPattern }) =>
        pattern.test(parsedUrl.hostname) &&
        (!pathPattern || pathPattern.test(parsedUrl.pathname)),
    )
  )
    return true;
  // Generic path patterns - match against pathname only to avoid false positives
  // from query parameters or fragments that happen to contain auth-related words.
  return GENERIC_AUTH_PATTERNS.some((p) => p.test(parsedUrl.pathname));
}

// ── DOM-based detection ──────────────────────────────────────────────

interface DomDetectionResult {
  type: AuthChallengeType;
  fields: AuthField[];
}

/**
 * JavaScript expression evaluated inside the page to detect auth-related
 * DOM elements. Returns a serialisable result or null.
 *
 * The expression is a self-contained IIFE so it can be passed as a string
 * to `Runtime.evaluate()` via {@link evaluateExpression}.
 */
const DOM_DETECT_EXPRESSION = `(() => {
  const fields = [];

  // ── Google-specific selectors ──────────────────────────────────
  const googleEmail = document.querySelector('#identifierId');
  if (googleEmail) {
    fields.push({ type: 'email', selector: '#identifierId', label: 'Google email' });
  }
  const googlePw = document.querySelector('input[type="password"][name="Passwd"]');
  if (googlePw) {
    fields.push({ type: 'password', selector: 'input[type="password"][name="Passwd"]', label: 'Google password' });
  }

  // ── Generic password inputs ────────────────────────────────────
  const pwInputs = document.querySelectorAll('input[type="password"]');
  for (const el of pwInputs) {
    const sel = 'input[type="password"]';
    // Avoid duplicating Google password already added
    if (el.getAttribute('name') === 'Passwd') continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'password';
    fields.push({ type: 'password', selector: sel, label });
  }

  // ── Email / username inputs ────────────────────────────────────
  const emailInputs = document.querySelectorAll(
    'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]'
  );
  for (const el of emailInputs) {
    if (el.id === 'identifierId') continue; // already handled
    const sel = el.id ? '#' + el.id : 'input[type="email"]';
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'email';
    fields.push({ type: 'email', selector: sel, label });
  }

  // ── 2FA / verification code inputs ─────────────────────────────
  const bodyText = (document.body && document.body.innerText) || '';
  const is2FAText = /verification code|two.?factor|2fa|authenticator|one.?time/i.test(bodyText);
  const codeInputs = document.querySelectorAll(
    'input[autocomplete="one-time-code"], input[name*="code"], input[name*="otp"], input[name*="token"], input[id*="code"], input[id*="otp"]'
  );

  if (is2FAText || codeInputs.length > 0) {
    for (const el of codeInputs) {
      const sel = el.id ? '#' + el.id : (el.getAttribute('name') ? 'input[name="' + el.getAttribute('name') + '"]' : 'input[autocomplete="one-time-code"]');
      const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'verification code';
      fields.push({ type: 'code', selector: sel, label });
    }
    // If we detected 2FA text but no specific code input, still report
    if (codeInputs.length === 0 && is2FAText) {
      fields.push({ type: 'code', selector: '', label: 'verification code (text detected)' });
    }
  }

  // ── OAuth consent buttons ──────────────────────────────────────
  const buttons = document.querySelectorAll('button, input[type="submit"], [role="button"]');
  const consentPatterns = /^(allow|approve|grant access|authorize|accept|consent)$/i;
  let hasConsentButton = false;
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (consentPatterns.test(text)) {
      hasConsentButton = true;
      const sel = btn.id ? '#' + btn.id : 'button';
      fields.push({ type: 'approval', selector: sel, label: text });
    }
  }

  // ── Sign in / Log in buttons (to support login detection) ──────
  const signInPatterns = /^(sign in|log in|login|sign up|continue)$/i;
  let hasSignInButton = false;
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (signInPatterns.test(text)) {
      hasSignInButton = true;
      break;
    }
  }

  // ── Classify ───────────────────────────────────────────────────
  const hasPassword = fields.some(f => f.type === 'password');
  const hasEmail = fields.some(f => f.type === 'email');
  const hasCode = fields.some(f => f.type === 'code');
  const hasApproval = fields.some(f => f.type === 'approval');

  if (hasApproval) {
    return { type: 'oauth_consent', fields };
  }
  if (hasCode && !hasPassword) {
    return { type: '2fa', fields: fields.filter(f => f.type === 'code') };
  }
  if (hasPassword || (hasEmail && hasSignInButton)) {
    return { type: 'login', fields: fields.filter(f => f.type === 'email' || f.type === 'password') };
  }
  if (is2FAText) {
    return { type: '2fa', fields: fields.filter(f => f.type === 'code') };
  }

  return null;
})()`;

// ── CAPTCHA / Cloudflare detection ───────────────────────────────────

const CAPTCHA_DETECT_EXPRESSION = `(() => {
  // Cloudflare Turnstile / interstitial
  const title = document.title || '';
  if (/just a moment/i.test(title)) return true;

  const bodyText = (document.body && document.body.innerText) || '';
  if (/verify you are human|performing security verification/i.test(bodyText)) return true;

  // Cloudflare-specific DOM elements
  const cfSelectors = [
    '#challenge-running',
    '#challenge-stage',
    '.cf-turnstile',
    'iframe[src*="challenges.cloudflare.com"]',
  ];
  for (const sel of cfSelectors) {
    if (document.querySelector(sel)) return true;
  }

  // reCAPTCHA - only flag visible challenges, not invisible v3 scoring widgets.
  // The challenge iframe (api2/bframe) or a visible .g-recaptcha container indicates
  // an interactive CAPTCHA the user must solve.
  if (document.querySelector('iframe[src*="recaptcha/api2/bframe"]')) return true;
  const recaptchaContainer = document.querySelector('.g-recaptcha');
  if (recaptchaContainer) {
    const rect = recaptchaContainer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }

  // hCaptcha - only flag when a visible challenge container is present
  const hcaptchaContainer = document.querySelector('#hcaptcha-container, .h-captcha');
  if (hcaptchaContainer) {
    const rect = hcaptchaContainer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }

  // hCaptcha fallback - catch custom-rendered hCaptcha in arbitrary host elements
  // by looking for any visible hCaptcha iframe (check all, not just the first)
  const hcaptchaIframes = document.querySelectorAll('iframe[src*="hcaptcha"]');
  for (const iframe of hcaptchaIframes) {
    const rect = iframe.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }

  return false;
})()`;

/**
 * Detect whether the current page presents a CAPTCHA or Cloudflare
 * challenge that requires human interaction.
 *
 * Migrated to CDP: runs {@link CAPTCHA_DETECT_EXPRESSION} via
 * `Runtime.evaluate` and reads the current URL via
 * {@link getCurrentUrl}. Errors (including {@link CdpError}) are
 * swallowed and reported as "no challenge" so the caller can treat
 * this as best-effort detection.
 */
export async function detectCaptchaChallenge(
  cdp: CdpClient,
  signal?: AbortSignal,
): Promise<AuthChallenge | null> {
  try {
    const isCaptcha = await evaluateExpression<boolean>(
      cdp,
      CAPTCHA_DETECT_EXPRESSION,
      {},
      signal,
    );
    if (isCaptcha) {
      const url = await getCurrentUrl(cdp, signal);
      return {
        type: "captcha",
        fields: [],
        url,
      };
    }
    return null;
  } catch {
    // Best-effort detection: swallow CdpError (aborted / disposed /
    // transport failures) and any other runtime error so a failed
    // probe is reported as "no challenge detected" instead of
    // bubbling up through navigation.
    return null;
  }
}

/**
 * Detect whether the current page presents an authentication challenge
 * (login form, 2FA prompt, or OAuth consent screen).
 *
 * Detection uses two complementary strategies:
 * 1. URL pattern matching against known auth providers.
 * 2. DOM inspection for login, 2FA, and consent UI elements.
 *
 * Returns an {@link AuthChallenge} if a challenge is detected, or `null`
 * if the page does not appear to be an auth page.
 *
 * Migrated to CDP: runs {@link DOM_DETECT_EXPRESSION} via
 * `Runtime.evaluate` and reads the current URL via
 * {@link getCurrentUrl}. Errors (including {@link CdpError}) are
 * swallowed and reported as "no challenge" so the caller can treat
 * this as best-effort detection.
 */
export async function detectAuthChallenge(
  cdp: CdpClient,
  signal?: AbortSignal,
): Promise<AuthChallenge | null> {
  try {
    const currentUrl = await getCurrentUrl(cdp, signal);
    const service = identifyService(currentUrl);
    const urlIsAuth = isAuthUrl(currentUrl);

    // DOM-based detection via Runtime.evaluate
    const domResult = await evaluateExpression<DomDetectionResult | null>(
      cdp,
      DOM_DETECT_EXPRESSION,
      {},
      signal,
    );

    if (domResult) {
      return {
        type: domResult.type,
        service,
        fields: domResult.fields,
        url: currentUrl,
      };
    }

    // If the URL strongly suggests an auth page but the DOM didn't
    // yield specific fields, still report it as a generic login challenge.
    if (urlIsAuth) {
      return {
        type: "login",
        service,
        fields: [],
        url: currentUrl,
      };
    }

    return null;
  } catch {
    // If Runtime.evaluate throws (e.g. page closed, navigation,
    // aborted, disposed) — or any other CDP/transport failure — treat
    // as no challenge. Matches the pre-CDP best-effort semantics.
    return null;
  }
}

/**
 * Format an {@link AuthChallenge} into a human-readable string suitable
 * for appending to browser_navigate output.
 */
export function formatAuthChallenge(challenge: AuthChallenge): string {
  const serviceName = challenge.service ? `${challenge.service} ` : "";
  const typeLabel =
    challenge.type === "login"
      ? "login page"
      : challenge.type === "2fa"
        ? "2FA verification"
        : challenge.type === "captcha"
          ? "CAPTCHA verification"
          : "OAuth consent screen";

  const lines: string[] = [
    `\u26a0\ufe0f Auth challenge detected: ${serviceName}${typeLabel}`,
    `  Type: ${challenge.type}`,
  ];

  if (challenge.fields.length > 0) {
    const fieldDescs = challenge.fields
      .map((f) => `${f.label} (${f.type})`)
      .join(", ");
    lines.push(`  Fields: ${fieldDescs}`);
  }

  return lines.join("\n");
}
