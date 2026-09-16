import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Page } from "playwright";

import type {} from "./fixtures/edge-swipe";

// Real layout and CSS overflow coercion are required for these regressions.
const build = await Bun.build({
  entrypoints: [
    fileURLToPath(new URL("./fixtures/edge-swipe.tsx", import.meta.url)),
  ],
  target: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" },
});
assert.ok(build.success, build.logs.join("\n"));
const bundle = await build.outputs[0].text();

async function setFixture(page: Page, content: string, contain = true) {
  await page.locator("#fixture").evaluate(
    (element, { content, contain }) => {
      element.innerHTML = `<div id="scroller"><div id="content"><div id="gap">Page content</div><div id="column" style="contain:${contain ? "content" : "none"}">${content}</div></div></div>`;
    },
    { content, contain },
  );
}

async function swipe(
  page: Page,
  selector: string,
  x: number,
  expectedCommits: number,
) {
  const result = await page.locator(selector).evaluate((target, x) => {
    Object.assign(window.edgeSwipeTest, { confirms: 0, moves: 0, commits: 0 });
    const y = target.getBoundingClientRect().top + 10;
    for (const [type, dx] of [
      ["touchstart", 0],
      ["touchmove", 30],
      ["touchmove", 120],
      ["touchend", 120],
    ] as const) {
      const point = { identifier: 1, clientX: x + dx, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : [point] },
        changedTouches: { value: [point] },
      });
      target.dispatchEvent(event);
      if (event.defaultPrevented) {
        throw new Error("The gesture must preserve native touch defaults");
      }
    }
    return window.edgeSwipeTest;
  }, x);
  assert.equal(result.commits, expectedCommits, `${selector} at x=${x}`);
  assert.equal(
    result.confirms,
    expectedCommits,
    `${selector} preview at x=${x}`,
  );
  if (expectedCommits === 0) {
    assert.equal(result.moves, 0);
  }
}

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    await page.setContent(`
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; }
        #fixture { width: 390px; overflow: hidden; }
        #scroller { display: flex; flex-direction: column; width: 100%; height: 400px; overflow-y: auto; }
        #content { display: flex; flex-direction: column; width: 100%; }
        #gap { height: 60px; }
        #column { width: 100%; padding: 0 16px; }
        #table { overflow-x: auto; }
        table { border-collapse: collapse; }
        td { height: 80px; }
      </style>
      <div id="root"></div><div id="fixture"></div>
    `);
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.edgeSwipeTest.ready);
    assert.ok(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    );

    // A contained wide child fits the transcript root; a stray sibling need not.
    await setFixture(
      page,
      '<div style="width:900px;height:80px">Wide content</div>',
    );
    assert.equal(
      await page.locator("#scroller").evaluate((el) => el.scrollWidth),
      390,
    );
    await swipe(page, "#gap", 100, 1);
    await page.locator("#content").evaluate((el) => {
      el.insertAdjacentHTML(
        "beforeend",
        '<div style="width:392px;height:500px">Incidental overflow</div>',
      );
    });
    const overflow = await page.locator("#scroller").evaluate((el) => ({
      x: getComputedStyle(el).overflowX,
      excess: el.scrollWidth - el.clientWidth,
    }));
    assert.deepEqual(overflow, { x: "auto", excess: 2 });
    await swipe(page, "#gap", 100, 1);

    await setFixture(
      page,
      '<div style="width:900px;height:80px">Wide content</div>',
      false,
    );
    assert.ok(
      await page
        .locator("#scroller")
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    );
    await swipe(page, "#gap", 100, 1);

    for (const messageText of [false, true]) {
      await setFixture(
        page,
        `<div ${messageText ? 'data-message-text=""' : ""}><div id="table" data-owns-horizontal-scroll><table style="width:900px"><tbody><tr><td>Table content</td></tr></tbody></table></div></div>`,
      );
      const maximum = await page
        .locator("#table")
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      assert.ok(maximum > 1);
      for (const position of [0, maximum / 2, maximum]) {
        await page.locator("#table").evaluate((el, x) => {
          el.scrollLeft = x;
        }, position);
        for (const startX of [20, 100]) {
          await swipe(page, "td", startX, 0);
        }
      }
      await page.locator("table").evaluate((el) => {
        el.style.width = "100%";
      });
      assert.equal(
        await page
          .locator("#table")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
        0,
      );
      await swipe(page, "td", 20, 1);
      await swipe(page, "td", 100, messageText ? 0 : 1);
      await swipe(page, "#column", 8, 1);
    }

    await setFixture(
      page,
      '<div id="table" data-owns-horizontal-scroll><div style="width:900px"><div id="inner" data-owns-horizontal-scroll style="width:200px;overflow-x:auto">Fits inside outer scroller</div></div></div>',
    );
    assert.equal(
      await page
        .locator("#inner")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
      0,
    );
    await swipe(page, "#inner", 100, 0);

    if (engine === chromium) {
      await setFixture(
        page,
        '<div id="table" data-owns-horizontal-scroll><table style="width:900px"><tbody><tr><td>Table content</td></tr></tbody></table></div>',
      );
      await page.locator("#table").evaluate((el) => {
        el.scrollLeft = 250;
        Object.assign(window.edgeSwipeTest, {
          confirms: 0,
          moves: 0,
          commits: 0,
        });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 100, y: 90 }],
      });
      for (const x of [120, 140, 160, 180, 200, 220]) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: 90 }],
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForFunction(
        () => document.getElementById("table")!.scrollLeft < 250,
      );
      const result = await page.evaluate(() => window.edgeSwipeTest);
      assert.equal(result.confirms, 0);
      assert.equal(result.commits, 0);
    }

    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: overflow, containment, table boundaries, narrow content, gutters, and nested owners passed`,
    );
  } finally {
    await browser.close();
  }
}
