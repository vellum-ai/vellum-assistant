import type { Page } from './browser-manager.js';

export interface CaptchaDetectionResult {
  detected: boolean;
  type?: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'unknown';
  hint?: string;
}

export const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]', '#recaptcha', '.g-recaptcha',
  'iframe[src*="hcaptcha"]', '.h-captcha',
  'iframe[src*="challenges.cloudflare.com"]', '.cf-turnstile',
  '[data-captcha]', 'img[alt*="captcha" i]',
];

export const CAPTCHA_TEXT_PATTERNS = [
  /i'm not a robot/i,
  /verify you are human/i,
  /security check/i,
  /complete the captcha/i,
];

/**
 * Maps a matched CSS selector to the CAPTCHA type it represents.
 */
function classifySelectorType(selector: string): CaptchaDetectionResult['type'] {
  if (selector.includes('recaptcha') || selector.includes('g-recaptcha')) {
    return 'recaptcha';
  }
  if (selector.includes('hcaptcha') || selector.includes('h-captcha')) {
    return 'hcaptcha';
  }
  if (selector.includes('cloudflare') || selector.includes('cf-turnstile')) {
    return 'turnstile';
  }
  return 'unknown';
}

/**
 * Detect whether the current page contains a CAPTCHA challenge.
 *
 * 1. Checks the DOM for known CAPTCHA selectors.
 * 2. Checks visible text content against known CAPTCHA text patterns.
 */
export async function detectCaptcha(page: Page): Promise<CaptchaDetectionResult> {
  try {
    // Step 1: Check DOM selectors via string-based evaluate
    const matchedSelector = await page.evaluate(`
      (() => {
        const selectors = ${JSON.stringify(CAPTCHA_SELECTORS)};
        for (const sel of selectors) {
          if (document.querySelector(sel)) {
            return sel;
          }
        }
        return null;
      })()
    `) as string | null;

    if (matchedSelector) {
      const type = classifySelectorType(matchedSelector);
      return {
        detected: true,
        type,
        hint: `Found element matching: ${matchedSelector}`,
      };
    }

    // Step 2: Check text content against patterns
    const bodyText = await page.evaluate(
      `document.body?.innerText ?? ''`,
    ) as string;

    for (const pattern of CAPTCHA_TEXT_PATTERNS) {
      if (pattern.test(bodyText)) {
        return {
          detected: true,
          type: 'unknown',
          hint: `Page text matches pattern: ${pattern.source}`,
        };
      }
    }

    return { detected: false };
  } catch {
    // If page.evaluate throws (e.g. page closed, navigation), treat as no CAPTCHA
    return { detected: false };
  }
}
