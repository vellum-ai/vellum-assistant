import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

import type {} from "./fixtures/browser-notification-delivery";

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./fixtures/browser-notification-delivery.ts", import.meta.url))],
  target: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" },
});
assert.ok(build.success, build.logs.join("\n"));
const bundle = await build.outputs[0].text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response('<!doctype html><title>Notification delivery test</title>', {
    headers: { "Content-Type": "text/html" },
  }),
});

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const pages = await Promise.all([context.newPage(), context.newPage()]);
      await Promise.all(pages.map(async (page) => {
        await page.goto(server.url.href);
        await page.addScriptTag({ content: bundle });
        assert.ok(await page.evaluate(() => !!navigator.locks));
      }));
      for (let i = 0; i < 20; i++) {
        const key = JSON.stringify(["account-1", "assistant-1", `signal-${i}`]);
        const results = await Promise.all(pages.map((page) => page.evaluate(
          (key) => window.notificationDeliveryTest.deliver(key), key,
        )));
        assert.deepEqual(results.sort(), ["duplicate", "posted"]);
      }
      const posted = await Promise.all(pages.map((page) => page.evaluate(
        () => window.notificationDeliveryTest.posted.length,
      )));
      assert.equal(posted.reduce((sum, count) => sum + count, 0), 20);

      assert.equal(await pages[0].evaluate(
        () => window.notificationDeliveryTest.deliver("retry", true),
      ), "failed");
      assert.equal(await pages[1].evaluate(
        () => window.notificationDeliveryTest.deliver("retry"),
      ), "posted");
      assert.equal(await pages[0].evaluate(
        () => window.notificationDeliveryTest.deliver("cancelled", false, false),
      ), "cancelled");
      for (const key of [
        '["account-2","assistant-1","signal-1"]',
        '["account-1","assistant-2","signal-1"]',
      ]) {
        assert.equal(await pages[1].evaluate(
          (key) => window.notificationDeliveryTest.deliver(key), key,
        ), "posted");
      }

      const conversationKey = '["account-1","assistant-1","conversation-1"]';
      await pages[0].evaluate(() => window.notificationDeliveryTest.setAttention(true));
      await pages[1].evaluate(() => window.notificationDeliveryTest.setAttention(false));
      await pages[0].evaluate((key) => window.notificationDeliveryTest.watchConversation(key), conversationKey);
      assert.equal(await pages[0].evaluate(() => document.hasFocus()), true);
      assert.equal(await pages[1].evaluate(() => document.hasFocus()), false);
      for (const order of [[0, 1], [1, 0]]) {
        for (const index of order) {
          assert.equal(await pages[index].evaluate(
            ({ key, signal }) => window.notificationDeliveryTest.deliver(signal, false, true, key),
            { key: conversationKey, signal: `attended-${order.join("-")}` },
          ), "suppressed");
        }
      }
      for (const key of [
        '["account-2","assistant-1","conversation-1"]',
        '["account-1","assistant-2","conversation-1"]',
        '["account-1","assistant-1","conversation-2"]',
      ]) {
        assert.equal(await pages[1].evaluate(
          (key) => window.notificationDeliveryTest.deliver(`scoped-${key}`, false, true, key), key,
        ), "posted");
      }
      await pages[0].evaluate(() => window.notificationDeliveryTest.setAttention(false));
      await pages[1].evaluate(() => window.notificationDeliveryTest.setAttention(true));
      await pages[0].waitForFunction(() => !document.hasFocus());
      assert.equal(await pages[1].evaluate(
        (key) => window.notificationDeliveryTest.deliver("after-blur", false, true, key), conversationKey,
      ), "posted");
      await pages[0].evaluate(() => window.notificationDeliveryTest.setAttention(true));
      await pages[1].evaluate(() => window.notificationDeliveryTest.setAttention(false));
      await pages[1].waitForFunction((key) => window.notificationDeliveryTest.isAttended(key), conversationKey);
      await pages[0].evaluate(() => window.notificationDeliveryTest.watchConversation(null));
      assert.equal(await pages[1].evaluate(
        (key) => window.notificationDeliveryTest.deliver("after-logout", false, true, key), conversationKey,
      ), "posted");
      await pages[0].evaluate((key) => {
        localStorage.setItem("vellum:browser-notification-attention:v1:abandoned", JSON.stringify([key, Date.now() - 1]));
      }, conversationKey);
      assert.equal(await pages[1].evaluate(
        (key) => window.notificationDeliveryTest.deliver("after-expiry", false, true, key), conversationKey,
      ), "posted");
      console.log(`${engine.name()}: two-page coordination, focused conversation in both arrival orders, blur/logout/expiry, failed-post retry, session cancellation, and identity isolation passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.stop(true);
}
