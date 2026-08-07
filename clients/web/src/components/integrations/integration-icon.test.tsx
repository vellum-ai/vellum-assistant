/**
 * Tests for `IntegrationIcon`.
 *
 * The contract under test is the *order* the component resolves a logo in:
 * a bundled asset we ship, then the provider's seeded `logoUrl` (a
 * third-party icon CDN), then an initials avatar. The order matters because
 * icon libraries drop brands on trademark request. Simple Icons hosts no
 * Microsoft mark and no Slack mark, so `cdn.simpleicons.org/microsoftoutlook`
 * 404s while the seed data still points at it, and a remote-first lookup
 * would strand Outlook on an "OU" avatar with `outlook.png` unused in
 * `public/`.
 *
 * Rendered via `@testing-library/react` (happy-dom, see
 * `clients/web/test-setup.ts`). happy-dom does not fetch `img` sources, so a
 * failing load is simulated with `fireEvent.error`.
 *
 * Bundled sources are matched on the `images/integrations/<file>` substring
 * rather than a whole-string compare. `publicAsset()` prefixes
 * `import.meta.env.BASE_URL`, which Vite supplies and the test runner does
 * not, so the leading segment differs between here and the browser.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { IntegrationIcon } from "./integration-icon";

const DEAD_CDN_URL = "https://cdn.simpleicons.org/microsoftoutlook";

afterEach(cleanup);

function renderIcon(props: {
  providerKey: string;
  displayName: string | null;
  logoUrl: string | null;
}) {
  return render(<IntegrationIcon {...props} />);
}

describe("IntegrationIcon", () => {
  test("prefers the bundled asset over the seeded CDN logoUrl", () => {
    const { container } = renderIcon({
      providerKey: "outlook",
      displayName: "Outlook / Microsoft",
      logoUrl: DEAD_CDN_URL,
    });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain(
      "images/integrations/outlook.png",
    );
    // Both failure shapes must be excluded: drawing the CDN URL, and
    // degrading to the initials avatar when that URL 404s.
    expect(img!.getAttribute("src")).not.toContain("simpleicons.org");
    expect(container.textContent).not.toContain("OU");
  });

  test("maps the manual-token Slack channel provider to the Slack asset", () => {
    const { container } = renderIcon({
      providerKey: "slack_channel",
      displayName: "Slack Channel",
      logoUrl: "https://cdn.simpleicons.org/slack",
    });

    expect(container.querySelector("img")!.getAttribute("src")).toContain(
      "images/integrations/slack.svg",
    );
  });

  test("uses the seeded logoUrl for a provider with no bundled asset", () => {
    // A runtime-registered provider, which is the case `logoUrl` exists for.
    // Deliberately not a real provider key: every seeded provider has a
    // bundled asset (enforced by `oauth-provider-seed-logos.test.ts`), so any
    // real key would resolve to the bundled branch instead of this one.
    const { container } = renderIcon({
      providerKey: "acme_internal_tool",
      displayName: "Acme Internal Tool",
      logoUrl: "https://cdn.example.com/acme.svg",
    });

    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      "https://cdn.example.com/acme.svg",
    );
  });

  test("falls through to the seeded logoUrl when the bundled asset fails", () => {
    const { container } = renderIcon({
      providerKey: "outlook",
      displayName: "Outlook / Microsoft",
      logoUrl: DEAD_CDN_URL,
    });

    fireEvent.error(container.querySelector("img")!);

    // Not the initials avatar: one failing source must not burn the others.
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(DEAD_CDN_URL);
  });

  test("falls back to an initials avatar only once every source has failed", () => {
    const { container } = renderIcon({
      providerKey: "outlook",
      displayName: "Outlook / Microsoft",
      logoUrl: DEAD_CDN_URL,
    });

    fireEvent.error(container.querySelector("img")!);
    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("OU");
  });

  test("renders the initials avatar when there is no logo at all", () => {
    const { container } = renderIcon({
      providerKey: "acme",
      displayName: "Acme Corp",
      logoUrl: null,
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("AC");
  });
});
