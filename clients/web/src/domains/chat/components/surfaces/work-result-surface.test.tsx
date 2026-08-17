import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import {
  parseItemLink,
  WorkResultSurface,
} from "@/domains/chat/components/surfaces/work-result-surface";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

function makeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "work_result",
    title: "Inbox cleaned up",
    data: {
      status: "completed",
      summary: "Archived low-signal mail and surfaced the important threads.",
      metrics: [
        { label: "Archived", value: 31, tone: "positive" },
        { label: "Needs reply", value: 2, tone: "warning" },
      ],
      sections: [
        {
          id: "attention",
          title: "Needs attention",
          type: "items",
          items: [
            {
              id: "contract",
              title: "Contract follow-up",
              description: "Alice asked for edits before tomorrow.",
              tone: "warning",
              status: "Reply today",
              metadata: [{ label: "Mailbox", value: "Work" }],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("WorkResultSurface", () => {
  test("renders metrics, sections, metadata, and action buttons", async () => {
    const onAction = mock(() => {});
    const { getByRole, getByText } = render(
      <WorkResultSurface
        surface={makeSurface({
          actions: [
            { id: "review", label: "Review", style: "primary" },
            { id: "undo", label: "Undo" },
          ],
        })}
        onAction={onAction}
      />,
    );

    expect(getByText("Inbox cleaned up")).toBeTruthy();
    expect(
      getByText("Archived low-signal mail and surfaced the important threads."),
    ).toBeTruthy();
    expect(getByText("31")).toBeTruthy();
    expect(getByText("Archived")).toBeTruthy();
    expect(getByText("Needs attention")).toBeTruthy();
    expect(getByText("Contract follow-up")).toBeTruthy();
    expect(getByText("Mailbox:")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Review" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("surface-1", "review", undefined);
    });
  });

  test("handles sparse data without crashing", () => {
    const { getByText } = render(
      <WorkResultSurface
        surface={makeSurface({ title: "Done", data: {} })}
        onAction={() => {}}
      />,
    );

    expect(getByText("Done")).toBeTruthy();
  });
});

describe("WorkResultSurface item links", () => {
  function linkedSurface(href: unknown): Surface {
    return makeSurface({
      data: {
        sections: [
          {
            title: "History",
            type: "items",
            items: [{ id: "history", title: "Full level-up history", href }],
          },
        ],
      },
    });
  }

  function LocationProbe() {
    const location = useLocation();
    return <div>At: {location.pathname + location.search}</div>;
  }

  function renderLinked(href: unknown) {
    return render(
      <MemoryRouter initialEntries={["/assistant/conversations/conv-1"]}>
        <WorkResultSurface surface={linkedSurface(href)} onAction={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    );
  }

  test("an in-app path renders as a link that navigates in place", async () => {
    const { getByRole, getByText } = renderLinked(
      "/assistant/skills/linear?tab=history",
    );

    const link = getByRole("link", { name: /Full level-up history/ });
    expect(link.getAttribute("href")).toBe(
      "/assistant/skills/linear?tab=history",
    );
    // In-app: no new tab, no external-link affordance.
    expect(link.getAttribute("target")).toBeNull();

    fireEvent.click(link);
    await waitFor(() => {
      expect(
        getByText("At: /assistant/skills/linear?tab=history"),
      ).toBeTruthy();
    });
  });

  test("an external URL renders as a new-tab anchor", () => {
    const { getByRole, getByText } = renderLinked("https://example.com/report");

    const link = getByRole("link", { name: /Full level-up history/ });
    expect(link.getAttribute("href")).toBe("https://example.com/report");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(getByText("At: /assistant/conversations/conv-1")).toBeTruthy();
  });

  test.each([
    ["javascript:alert(1)"],
    ["//evil.example/x"],
    // The URL parser reads a backslash as a slash after a special scheme, and
    // strips tabs and newlines before looking for an authority, so these
    // resolve to another host for middle-click / copy-link.
    ["/\\evil.example/x"],
    ["/\t/evil.example/x"],
    ["/\n\\evil.example/x"],
    ["//["],
    ["assistant/skills/linear"],
    ["#"],
    [""],
    [42],
  ])("%p is not a link", (href) => {
    const { getByText, queryByRole } = renderLinked(href);

    expect(getByText("Full level-up history")).toBeTruthy();
    expect(queryByRole("link")).toBeNull();
  });
});

describe("parseItemLink", () => {
  test("classifies in-app paths and external schemes", () => {
    expect(parseItemLink("/assistant/skills/linear?tab=history")).toEqual({
      href: "/assistant/skills/linear?tab=history",
      kind: "app",
    });
    expect(parseItemLink(" https://example.com ")).toEqual({
      href: "https://example.com",
      kind: "external",
    });
    expect(parseItemLink("mailto:someone@example.com")).toEqual({
      href: "mailto:someone@example.com",
      kind: "external",
    });
    expect(parseItemLink("/")).toEqual({ href: "/", kind: "app" });
    expect(parseItemLink("//example.com")).toBeUndefined();
    expect(parseItemLink("/\\example.com")).toBeUndefined();
    expect(parseItemLink("javascript:alert(1)")).toBeUndefined();
    expect(parseItemLink(undefined)).toBeUndefined();
  });
});

describe("SurfaceRouter", () => {
  test("routes work_result surfaces", () => {
    const { queryByText, getByText } = render(
      <SurfaceRouter surface={makeSurface()} onAction={() => {}} />,
    );

    expect(queryByText("Unsupported surface type: work_result")).toBeNull();
    expect(getByText("Inbox cleaned up")).toBeTruthy();
  });
});
