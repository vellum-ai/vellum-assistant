/**
 * Tests for `ExternalAnchor`, the one place external links are opened.
 *
 * The behaviour worth pinning is the native-shell path: on iOS/Android a bare
 * `target="_blank"` anchor silently does nothing, so a surface that forgets the
 * click handler looks perfectly healthy on web and desktop while its links are
 * dead on the phone. That is the regression these tests exist to catch.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// Toggled per-test rather than re-mocked: `mock.module` is process-global, so a
// second registration would leak into the rest of the file.
let nativePlatform = false;
let openedUrl: string | null = null;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));

mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

import { ExternalAnchor, isWebUrl } from "@/components/external-anchor";
import { FileMarkdown } from "@/components/file-markdown";

afterEach(() => {
  cleanup();
  nativePlatform = false;
  openedUrl = null;
});

describe("ExternalAnchor", () => {
  test("carries the new-tab attributes and keeps the href copyable", () => {
    render(
      <ExternalAnchor href="https://example.com/jobs">Jobs</ExternalAnchor>,
    );

    const anchor = screen.getByRole("link", { name: "Jobs" });
    expect(anchor.getAttribute("href")).toBe("https://example.com/jobs");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("on a native shell, opens through the native browser instead of _blank", () => {
    nativePlatform = true;
    render(
      <ExternalAnchor href="https://example.com/jobs">Jobs</ExternalAnchor>,
    );

    screen.getByRole("link", { name: "Jobs" }).click();

    expect(openedUrl).toBe("https://example.com/jobs");
  });

  test("on web, leaves the click to the browser's default new-tab handling", () => {
    render(
      <ExternalAnchor href="https://example.com/jobs">Jobs</ExternalAnchor>,
    );

    screen.getByRole("link", { name: "Jobs" }).click();

    expect(openedUrl).toBeNull();
  });
});

/**
 * `FileMarkdown` backs the attachment preview, skill and plugin readmes,
 * concept notes, and the workspace file viewer. Its links route through
 * `ExternalAnchor`, so drive the real chain rather than the anchor alone.
 */
describe("FileMarkdown links", () => {
  test("open through the native browser on a native shell", () => {
    nativePlatform = true;
    render(<FileMarkdown content="[IISc record](https://example.com/jobs)" />);

    screen.getByRole("link", { name: /IISc record/ }).click();

    expect(openedUrl).toBe("https://example.com/jobs");
  });

  test("mark http destinations with the external-link glyph", () => {
    const { container } = render(
      <FileMarkdown
        content={
          "[web](https://example.com) and [mail](mailto:user@example.com)"
        }
      />,
    );

    const [web, mail] = Array.from(container.querySelectorAll("a"));
    expect(web?.querySelector("svg")).not.toBeNull();
    expect(mail?.querySelector("svg")).toBeNull();
  });
});

describe("isWebUrl", () => {
  test("is true for http(s) destinations", () => {
    expect(isWebUrl("https://example.com")).toBe(true);
    expect(isWebUrl("HTTP://example.com")).toBe(true);
  });

  test("is false for everything else a markdown link can carry", () => {
    expect(isWebUrl("mailto:user@example.com")).toBe(false);
    expect(isWebUrl("/assistant/settings")).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});
