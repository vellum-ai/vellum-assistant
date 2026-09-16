import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import {
  clearAppHtmlCache,
  getCachedAppHtml,
  primeAppHtmlCache,
} from "@/utils/app-html-cache";

const ASSISTANT_ID = "assistant-123";
const APP_ID = "app-123";
const SCAFFOLD = "<html><body>Loading...</body></html>";
const FINISHED = "<html><body><h1>Expense tracker</h1></body></html>";
const post = spyOn(client, "post");
afterAll(() => post.mockRestore());

function respondWith(html: unknown): void {
  post.mockResolvedValue({ data: { html } } as never);
}

afterEach(() => {
  clearAppHtmlCache(ASSISTANT_ID, APP_ID);
  post.mockReset();
});

describe("app HTML cache", () => {
  test("shares one request across thumbnails and the viewer for one revision", async () => {
    respondWith(FINISHED);
    const first = getCachedAppHtml(ASSISTANT_ID, APP_ID, 1);
    expect(getCachedAppHtml(ASSISTANT_ID, APP_ID, 1)).toBe(first);
    expect(getCachedAppHtml(ASSISTANT_ID, APP_ID)).toBe(first);
    expect(await first).toBe(FINISHED);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("loads the finished app when its summary advances past the scaffold", async () => {
    respondWith(SCAFFOLD);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 1)).toBe(SCAFFOLD);
    respondWith(FINISHED);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(FINISHED);
    expect(post).toHaveBeenCalledTimes(2);
  });

  test("does not reuse an unversioned scaffold for a versioned thumbnail", async () => {
    respondWith(SCAFFOLD);
    await getCachedAppHtml(ASSISTANT_ID, APP_ID);
    respondWith(FINISHED);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(FINISHED);
  });

  test.each([{}, { html: FINISHED }, null, undefined, "", "   "])(
    "rejects invalid HTML %j and lets a subsequent load recover",
    async (html) => {
      respondWith(html);
      await expect(getCachedAppHtml(ASSISTANT_ID, APP_ID, 1)).rejects.toThrow(
        "App response did not contain HTML",
      );
      respondWith(FINISHED);
      expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 1)).toBe(FINISHED);
    },
  );

  test("a failed older request cannot evict a newer revision", async () => {
    const pending = Promise.withResolvers<never>();
    post.mockReturnValueOnce(pending.promise);
    const older = getCachedAppHtml(ASSISTANT_ID, APP_ID, 1);
    const failure = older.catch((error: unknown) => error);
    respondWith(FINISHED);
    const newer = getCachedAppHtml(ASSISTANT_ID, APP_ID, 2);
    expect(await newer).toBe(FINISHED);
    pending.reject(new Error("Old build unavailable"));
    expect(await failure).toEqual(new Error("Old build unavailable"));
    expect(getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(newer);
    expect(post).toHaveBeenCalledTimes(2);
  });

  test("a late scaffold response cannot replace the finished revision", async () => {
    const pending = Promise.withResolvers<never>();
    post.mockReturnValueOnce(pending.promise);
    const older = getCachedAppHtml(ASSISTANT_ID, APP_ID, 1);
    respondWith(FINISHED);
    await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2);
    pending.resolve({ data: { html: SCAFFOLD } } as never);
    await older;
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(FINISHED);
  });

  test("primed HTML is shared for its revision and refreshed for a newer build", async () => {
    primeAppHtmlCache(ASSISTANT_ID, APP_ID, SCAFFOLD, 1);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 1)).toBe(SCAFFOLD);
    expect(post).not.toHaveBeenCalled();
    respondWith(FINISHED);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(FINISHED);
  });

  test("an unversioned prime cannot inherit a cached revision", async () => {
    respondWith(FINISHED);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(FINISHED);
    primeAppHtmlCache(ASSISTANT_ID, APP_ID, SCAFFOLD);
    respondWith(FINISHED);
    expect(await getCachedAppHtml(ASSISTANT_ID, APP_ID, 2)).toBe(FINISHED);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
