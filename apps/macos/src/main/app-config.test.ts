import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RENDERER_BASE_PROD, getRendererRootUrl } from "./app-config";

const ORIGINAL_DEV_URL = process.env.VELLUM_DEV_URL;

beforeEach(() => {
  delete process.env.VELLUM_DEV_URL;
});

afterEach(() => {
  if (ORIGINAL_DEV_URL === undefined) {
    delete process.env.VELLUM_DEV_URL;
  } else {
    process.env.VELLUM_DEV_URL = ORIGINAL_DEV_URL;
  }
});

describe("getRendererRootUrl", () => {
  test("packaged builds load the slashless prod base the app:// handler maps to index.html", () => {
    expect(getRendererRootUrl(true)).toBe(RENDERER_BASE_PROD);
  });

  test("dev loads the standalone Vite fallback with a trailing slash to match Vite's base", () => {
    expect(getRendererRootUrl(false)).toBe("http://localhost:5173/assistant/");
  });

  test("dev appends exactly one trailing slash to VELLUM_DEV_URL", () => {
    process.env.VELLUM_DEV_URL = "http://localhost:3000/assistant";
    expect(getRendererRootUrl(false)).toBe("http://localhost:3000/assistant/");
  });

  test("dev collapses a VELLUM_DEV_URL that already carries a trailing slash", () => {
    process.env.VELLUM_DEV_URL = "http://localhost:3000/assistant/";
    expect(getRendererRootUrl(false)).toBe("http://localhost:3000/assistant/");
  });
});
