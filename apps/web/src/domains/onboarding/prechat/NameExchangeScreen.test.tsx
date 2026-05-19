/**
 * Structural smoke tests for the PreChat NameExchangeScreen — same
 * `renderToStaticMarkup` pattern as the other onboarding screens.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
}));

import { NameExchangeScreen } from "@/domains/onboarding/prechat/NameExchangeScreen.js";

const NOOP = () => {};

const SUGGESTIONS = ["Pax", "Atlas", "Sage", "Nova", "Kit"];

function renderScreen(overrides: Partial<Parameters<typeof NameExchangeScreen>[0]> = {}) {
  return renderToStaticMarkup(
    <NameExchangeScreen
      userName=""
      assistantName=""
      selectedGroupId={null}
      displayedAssistantNames={SUGGESTIONS}
      onUserNameChange={NOOP}
      onAssistantNameChange={NOOP}
      onGroupChange={NOOP}
      onBack={NOOP}
      onComplete={NOOP}
      onSkip={NOOP}
      {...overrides}
    />,
  );
}

describe("NameExchangeScreen", () => {
  test("renders the off-scale title", () => {
    const html = renderScreen();
    const normalized = html.replace(/&#x27;/g, "'").replace(/&apos;/g, "'");
    expect(normalized).toContain("Let's get to know each other.");
  });

  test("renders both Input labels", () => {
    const html = renderScreen();
    const normalized = html.replace(/&#x27;/g, "'").replace(/&apos;/g, "'");
    expect(normalized).toContain("Your name");
    expect(normalized).toContain("What should I go by?");
  });

  test("renders the subtitle", () => {
    const html = renderScreen();
    expect(html).toContain("You can change these any time.");
  });

  test("renders 'A few to try' label regardless of group selection", () => {
    expect(renderScreen()).toContain("A few to try");
    expect(renderScreen({ selectedGroupId: "grounded" })).toContain("A few to try");
  });

  test("renders all suggestion pills with the names provided", () => {
    const html = renderScreen();
    for (const name of SUGGESTIONS) {
      expect(html).toContain(`>${name}<`);
    }
  });

  test("renders all 4 vibe cards", () => {
    const html = renderScreen();
    expect(html).toContain("Calm and precise");
    expect(html).toContain("Warm and easy");
    expect(html).toContain("Fast and direct");
    expect(html).toContain("Quiet and observant");
  });

  test("active pill (matching assistantName) carries aria-pressed=true", () => {
    const html = renderScreen({ assistantName: "Sage" });
    expect(html).toMatch(
      /<button[^>]*aria-pressed="true"[^>]*>(?:[^<]|<(?!\/button))*Sage<\/button>/,
    );
  });

  test("renders Back button with accessible label when onBack is provided", () => {
    const html = renderScreen({ onBack: NOOP });
    expect(html).toMatch(/aria-label="Back"/);
  });

  test("does NOT render a Back button when onBack is omitted", () => {
    const html = renderScreen({ onBack: undefined });
    expect(html).not.toMatch(/aria-label="Back"/);
  });

  test("primary 'Let's go' button is always enabled (no disabled attr)", () => {
    const html = renderScreen();
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>(?:[^<]|<(?!\/button))*Let&#x27;s go<\/button>/,
    );
  });

  test("renders the Skip ghost button", () => {
    const html = renderScreen();
    expect(html).toContain(">Skip<");
  });

  test("renders the userName prop as the value of the 'Your name' input", () => {
    // Apple App Store Guideline 4: when Authentication Services already
    // provided a name, the field must be pre-filled rather than forcing
    // the user to retype it. The screen renders whatever the parent
    // passes — PreChatFlow seeds this prop from useAuth().firstName.
    // The "Your name" input is the only one with placeholder="Your name"
    // (the assistant input uses placeholder="Assistant name"), so a
    // single match against placeholder + value is unambiguous.
    const html = renderScreen({ userName: "Magic" });
    expect(html).toMatch(
      /<input[^>]*placeholder="Your name"[^>]*value="Magic"|<input[^>]*value="Magic"[^>]*placeholder="Your name"/,
    );
  });

  test("renders an empty 'Your name' input when no userName is supplied", () => {
    // Email/password signup parity: when no profile name is available,
    // the field stays empty and the user types as before.
    const html = renderScreen({ userName: "" });
    expect(html).toMatch(
      /<input[^>]*placeholder="Your name"[^>]*value=""|<input[^>]*value=""[^>]*placeholder="Your name"/,
    );
  });

  test("does NOT pre-fill the assistant-name input from userName", () => {
    // The assistant-name field is independent of the user-name pre-fill;
    // pre-filling it from the user's profile would be wrong (it's the
    // name of the assistant, not the user).
    const html = renderScreen({ userName: "Magic", assistantName: "" });
    expect(html).toMatch(
      /<input[^>]*placeholder="Assistant name"[^>]*value=""|<input[^>]*value=""[^>]*placeholder="Assistant name"/,
    );
  });
});
