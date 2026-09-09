/**
 * `/docs/help/faq` is the public platform list the assistant is told to
 * fetch. These tests lock Android, Windows/Linux honesty, Base plan, and
 * the phone in-app browser gap.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HelpFaqContent } from "@/app/docs/_components/help-faq-content";

const html = renderToStaticMarkup(<HelpFaqContent />);

describe("HelpFaqContent", () => {
  test("lists Android next to iOS and links the stores", () => {
    expect(html).toContain("Android app");
    expect(html).toContain("Google Play");
    expect(html).toContain("play.google.com/store/apps/details?id=ai.vellum.assistant");
    expect(html).toContain("apps.apple.com/us/app/vellum-assistant/id6759934423");
  });

  test("is honest about Windows and Linux desktop clients", () => {
    expect(html).toContain("no shipped Windows or Linux desktop client");
    expect(html).toContain("Is there a Windows app?");
    expect(html).toContain("Does it run on Linux?");
    expect(html).toContain("self-host the assistant runtime on a Linux");
    expect(html).not.toContain("download the Windows");
  });

  test("describes Base as the free plan and points at Pricing", () => {
    expect(html).toContain("Is Vellum free?");
    expect(html).toContain("Base");
    expect(html).toContain("/docs/pricing");
  });

  test("says phone apps have no in-app browser for CAPTCHA walls", () => {
    expect(html).toContain("do not include an in-app browser");
    expect(html).toContain("CAPTCHA");
    expect(html).toContain("Chrome extension");
  });
});
