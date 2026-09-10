import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type { AppSummary } from "@/types/app-types";
import {
  restoreStubbedModules,
  stubModule,
} from "@/utils/module-mock.test-helper";

stubModule(
  "@/domains/library/components/library-app-card",
  await import("@/domains/library/components/library-app-card"),
  {
    LibraryAppCard: ({ app }: { app: AppSummary }) => (
      <article>{app.name}</article>
    ),
  },
);

const { LibraryGridSection } = await import(
  "@/domains/library/components/library-grid-section"
);

const APP: AppSummary = {
  id: "app-123",
  name: "Example App",
  createdAt: 1767225600000,
  updatedAt: 1767225600000,
  version: "1",
  contentId: "content-123",
  origin: "workspace",
};

afterEach(() => {
  cleanup();
});

afterAll(() => {
  restoreStubbedModules();
});

describe("LibraryGridSection card surface", () => {
  test("backs swipe content with the same surface as the library page", () => {
    const { container } = render(
      <LibraryGridSection
        title="Recents"
        apps={[APP]}
        assistantId="assistant-123"
        pinnedAppIds={new Set()}
        onOpen={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
      />,
    );

    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain(
      "max-md:[--swipe-item-surface:var(--surface-overlay)]",
    );
    expect(grid?.className).toContain(
      "[--swipe-item-surface:var(--surface-base)]",
    );
    expect(container.querySelector("h2")?.className).toContain(
      "max-md:sr-only",
    );
  });
});
