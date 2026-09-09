/**
 * `/docs/getting-started/installation` lists the shipped clients. These
 * tests lock the public install matrix: iOS, Android, macOS, web, and
 * self-host, with no shipped Windows or Linux desktop client.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GettingStartedContent } from "@/app/docs/_components/getting-started-content";

const html = renderToStaticMarkup(<GettingStartedContent />);

function tocTargets(markup: string): string[] {
  const listStart = markup.indexOf("On this page");
  expect(listStart).toBeGreaterThan(-1);
  const list = markup.slice(listStart, markup.indexOf("</ul>", listStart));
  return [...list.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!);
}

describe("GettingStartedContent", () => {
  test("names the shipped mobile clients and store listings", () => {
    expect(html).toContain("Android app");
    expect(html).toContain("Google Play");
    expect(html).toContain("play.google.com/store/apps/details?id=ai.vellum.assistant");
    expect(html).toContain("App Store");
    expect(html).toContain("apps.apple.com/us/app/vellum-assistant/id6759934423");
  });

  test("points macOS install at the public downloads page", () => {
    expect(html).toContain("vellum.ai/downloads");
    expect(html).toContain("/downloads");
    expect(html).toContain("Desktop app (macOS)");
  });

  test("states there is no shipped Windows or Linux desktop client", () => {
    expect(html).toContain("no shipped Windows or Linux desktop client");
    expect(html).toContain("Windows and Linux");
    expect(html).toContain("self-host the assistant runtime");
  });

  test("says phone apps have no in-app browser for CAPTCHA and login walls", () => {
    expect(html).toContain("does not include an in-app browser");
    expect(html).toContain("CAPTCHA");
  });

  test("carries no contents entry for a section that is not on the page", () => {
    const targets = tocTargets(html);
    expect(targets).toContain("android-app");
    expect(targets).toContain("windows-and-linux");
    for (const target of targets) {
      expect(html).toContain(`id="${target}"`);
    }
  });
});
