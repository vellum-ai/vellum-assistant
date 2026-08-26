import { describe, expect, test } from "bun:test";

import { labelFromUserAgent } from "./device-label";

describe("labelFromUserAgent", () => {
  test("desktop Chrome on macOS", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "macOS" });
  });

  test("desktop Chrome on Windows", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Windows" });
  });

  test("Firefox on Linux", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
      ),
    ).toEqual({ browser: "Firefox", os: "Linux" });
  });

  test("Edge on Windows is not reported as Chrome", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      ),
    ).toEqual({ browser: "Edge", os: "Windows" });
  });

  test("Safari on macOS", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toEqual({ browser: "Safari", os: "macOS" });
  });

  test("mobile Safari on iPhone reports OS iPhone, not macOS", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari", os: "iPhone" });
  });

  test("Edge on Android is not reported as Chrome", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.42",
      ),
    ).toEqual({ browser: "Edge", os: "Android" });
  });

  test("Edge on iOS is not reported as Safari", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 EdgiOS/128.2739.44 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Edge", os: "iPhone" });
  });

  test("Opera on iOS is not reported as Safari", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 OPiOS/8.5.2.93674 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Opera", os: "iPhone" });
  });

  test("Chrome on Android", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Android" });
  });

  test("iPad user agent", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari", os: "iPad" });
  });

  test("desktop-mode iPad Safari reports OS iPad, not macOS", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari", os: "iPad" });
  });

  test("Firefox on iOS is not reported as Safari", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15",
      ),
    ).toEqual({ browser: "Firefox", os: "iPhone" });
  });

  test("iOS WKWebView user agent with no Safari/ token still resolves OS", () => {
    expect(
      labelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ),
    ).toEqual({ browser: null, os: "iPhone" });
  });

  test("garbage string yields null, not a partially-empty object", () => {
    expect(labelFromUserAgent("not a real user agent string 12345")).toBeNull();
  });

  test("empty string yields null", () => {
    expect(labelFromUserAgent("")).toBeNull();
  });

  test("null input yields null", () => {
    expect(labelFromUserAgent(null)).toBeNull();
  });

  test("undefined input yields null", () => {
    expect(labelFromUserAgent(undefined)).toBeNull();
  });
});
