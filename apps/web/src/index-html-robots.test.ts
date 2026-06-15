import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const INDEX_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function readHeadHtml(): string {
  const match = /<head>([\s\S]*?)<\/head>/.exec(INDEX_HTML);
  expect(match).not.toBeNull();
  return match![1]!;
}

function readRobotsAllowlistScript(): string {
  const match =
    /<script data-robots-allowlist>([\s\S]*?)<\/script>/.exec(INDEX_HTML);
  expect(match).not.toBeNull();
  return match![1]!;
}

function runRobotsAllowlist(pathname: string): HTMLMetaElement | null {
  window.history.pushState(null, "", pathname);
  document.head.innerHTML = readHeadHtml();

  // Execute the exact inline script from index.html after the head is parsed.
  new Function(readRobotsAllowlistScript())();

  return document.querySelector('meta[name="robots"]');
}

describe("index.html robots metadata", () => {
  test("keeps app routes noindexed by default", () => {
    expect(
      runRobotsAllowlist("/assistant/conversations/conversation-123")?.content,
    ).toBe("noindex, nofollow");
  });

  test("keeps non-login account routes noindexed by default", () => {
    expect(runRobotsAllowlist("/account/provider/callback")?.content).toBe(
      "noindex, nofollow",
    );
  });

  test("removes the robots tag for the login page", () => {
    expect(runRobotsAllowlist("/account/login")).toBeNull();
  });
});
