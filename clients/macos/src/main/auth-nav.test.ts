import { describe, expect, test } from "bun:test";

import { decideNavigation } from "./auth-nav";

const APP = { protocol: "http:", host: "localhost:3000" } as const;

describe("decideNavigation", () => {
  test("allows same-origin navigation", () => {
    expect(
      decideNavigation("http://localhost:3000/account/login", APP),
    ).toEqual({ kind: "allow" });
  });

  test("ejects cross-origin http(s) to the system browser", () => {
    expect(
      decideNavigation("https://accounts.google.com/signin", APP),
    ).toEqual({ kind: "external", url: "https://accounts.google.com/signin" });
  });

  test("blocks non-http schemes", () => {
    expect(decideNavigation("mailto:hi@vellum.ai", APP)).toEqual({
      kind: "block",
    });
    expect(decideNavigation("file:///etc/passwd", APP)).toEqual({
      kind: "block",
    });
  });

  test("blocks unparseable URLs", () => {
    expect(decideNavigation("::::", APP)).toEqual({ kind: "block" });
  });

  test("allows the app origin", () => {
    expect(
      decideNavigation(
        "http://localhost:3000/account/provider/callback",
        APP,
      ),
    ).toEqual({ kind: "allow" });
  });
});
