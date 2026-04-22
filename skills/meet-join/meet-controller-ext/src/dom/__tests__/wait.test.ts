import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { waitForAny, waitForSelector } from "../wait.js";

/**
 * `waitForSelector` / `waitForAny` read `MutationObserver` from `globalThis`.
 * Bun has no DOM, so we borrow it from a scratch JSDOM window for the life
 * of this test file and restore the prior value afterwards — mirroring the
 * pattern in `src/__tests__/join.test.ts`.
 */
const JSDOM_GLOBALS = ["MutationObserver"] as const;
const previousGlobals: Record<string, unknown> = {};

beforeAll(() => {
  const dom = new JSDOM("<html><body></body></html>");
  for (const key of JSDOM_GLOBALS) {
    previousGlobals[key] = (globalThis as unknown as Record<string, unknown>)[
      key
    ];
    (globalThis as unknown as Record<string, unknown>)[key] = (
      dom.window as unknown as Record<string, unknown>
    )[key];
  }
});

afterAll(() => {
  for (const key of JSDOM_GLOBALS) {
    (globalThis as unknown as Record<string, unknown>)[key] =
      previousGlobals[key];
  }
});

/**
 * The `interactable` filter's purpose is to skip hidden template/transition
 * nodes Meet keeps in the prejoin tree. These tests assert the filter rejects
 * the forms of "hidden" we can express in jsdom — inline style and aria/hidden
 * attributes on self or ancestor — and accepts a plain visible node.
 *
 * jsdom has no layout engine, so the `Element.checkVisibility()` branch is
 * exercised only in a real browser. The attribute/style branch is what
 * protects us in tests and in production for the explicit-hidden cases.
 */

function buildDoc(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("waitForSelector interactable filter", () => {
  test("matches a plain visible button synchronously", async () => {
    const doc = buildDoc(`<body><button id="a">go</button></body>`);
    const el = await waitForSelector("#a", 100, doc, { interactable: true });
    expect(el.id).toBe("a");
  });

  test("skips aria-hidden elements and falls through to timeout", async () => {
    const doc = buildDoc(
      `<body><button id="a" aria-hidden="true">ghost</button></body>`,
    );
    await expect(
      waitForSelector("#a", 50, doc, { interactable: true }),
    ).rejects.toThrow(/timeout waiting for #a/);
  });

  test("skips elements hidden via inline display:none", async () => {
    const doc = buildDoc(
      `<body><button id="a" style="display:none">ghost</button></body>`,
    );
    await expect(
      waitForSelector("#a", 50, doc, { interactable: true }),
    ).rejects.toThrow(/timeout waiting for #a/);
  });

  test("skips elements whose ancestor is hidden", async () => {
    const doc = buildDoc(
      `<body><div aria-hidden="true"><button id="a">ghost</button></div></body>`,
    );
    await expect(
      waitForSelector("#a", 50, doc, { interactable: true }),
    ).rejects.toThrow(/timeout waiting for #a/);
  });

  test("iterates all matches and returns the first interactable one", async () => {
    // Regression: `querySelector` only returns the first hit, so a hidden
    // template node earlier in the tree used to mask a later interactable
    // sibling. The fix iterates `querySelectorAll`.
    const doc = buildDoc(
      `<body>
        <button class="c" aria-hidden="true">ghost</button>
        <button class="c" id="real">real</button>
      </body>`,
    );
    const el = await waitForSelector(".c", 100, doc, { interactable: true });
    expect(el.id).toBe("real");
  });

  test("resolves once a hidden match becomes interactable", async () => {
    const doc = buildDoc(
      `<body><button id="a" aria-hidden="true">pending</button></body>`,
    );
    // Flip the attribute after a tick — the observer should pick it up.
    setTimeout(() => {
      doc.getElementById("a")?.removeAttribute("aria-hidden");
    }, 10);
    const el = await waitForSelector("#a", 500, doc, { interactable: true });
    expect(el.id).toBe("a");
  });

  test("without the flag, hidden nodes still match", async () => {
    const doc = buildDoc(
      `<body><button id="a" aria-hidden="true">ghost</button></body>`,
    );
    const el = await waitForSelector("#a", 100, doc);
    expect(el.id).toBe("a");
  });
});

describe("waitForAny interactable filter", () => {
  test("skips a hidden earlier match and resolves on a later visible one", async () => {
    const doc = buildDoc(
      `<body>
        <button id="ghost" aria-label="Join now" aria-hidden="true">ghost</button>
        <button id="real" aria-label="Ask to join">real</button>
      </body>`,
    );
    const { selector, element } = await waitForAny(
      ['button[aria-label="Join now"]', 'button[aria-label="Ask to join"]'],
      100,
      doc,
      { interactable: true },
    );
    expect(selector).toBe('button[aria-label="Ask to join"]');
    expect(element.id).toBe("real");
  });

  test("matches the first visible candidate", async () => {
    const doc = buildDoc(
      `<body>
        <button aria-label="Join now">real</button>
        <button aria-label="Ask to join">also real</button>
      </body>`,
    );
    const { selector } = await waitForAny(
      ['button[aria-label="Join now"]', 'button[aria-label="Ask to join"]'],
      100,
      doc,
      { interactable: true },
    );
    expect(selector).toBe('button[aria-label="Join now"]');
  });

  test("times out when every candidate is hidden", async () => {
    const doc = buildDoc(
      `<body>
        <button aria-label="Join now" style="display:none">a</button>
        <button aria-label="Ask to join" aria-hidden="true">b</button>
      </body>`,
    );
    await expect(
      waitForAny(
        ['button[aria-label="Join now"]', 'button[aria-label="Ask to join"]'],
        50,
        doc,
        { interactable: true },
      ),
    ).rejects.toThrow(/timeout waiting for any of/);
  });
});
