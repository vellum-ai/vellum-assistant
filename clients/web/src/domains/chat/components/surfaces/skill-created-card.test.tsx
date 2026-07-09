import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

// `mock.module` is safe for `use-is-mobile` because it's a pure
// derived-value hook (no module-local state). Tests that don't touch
// `isMobileRef` default to `false` (wide viewport).
const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

import { SkillCreatedCard } from "@/domains/chat/components/surfaces/skill-created-card";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useViewerStore } from "@/stores/viewer-store";

// `skill-creation-card` defaults off; every rendering test below exercises
// the flag-on path. The dedicated kill-switch test flips it back off.
beforeEach(() => {
  useClientFeatureFlagStore.setState({ skillCreationCard: true });
});

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
  // Clicks mutate the real viewer store; restore it for the next test.
  useViewerStore.getState().reset();
  useClientFeatureFlagStore.setState({ skillCreationCard: false });
});

function makeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "skill-card-conv-xyz",
    surfaceType: "skill_card",
    title: "New skill learned",
    display: "inline",
    data: {
      skills: [
        {
          skillId: "skill-1",
          name: "Weekly report digest",
          description: "Compile the weekly report from the usual sources.",
          emoji: "📊",
        },
      ],
    },
    ...overrides,
  };
}

/** Exposes the router's current URL so tests can assert navigation. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderCard(surface: Surface) {
  return render(
    <MemoryRouter initialEntries={["/assistant/conversations/conv-xyz"]}>
      <SkillCreatedCard surface={surface} onAction={() => {}} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("SkillCreatedCard", () => {
  test("renders the header, subline, and a skill row", () => {
    const { getByText, getByRole } = renderCard(makeSurface());

    expect(getByText("New skill learned")).toBeTruthy();
    expect(
      getByText("Saved to your skills from this conversation's work"),
    ).toBeTruthy();
    expect(getByText("Weekly report digest")).toBeTruthy();
    expect(
      getByText("Compile the weekly report from the usual sources."),
    ).toBeTruthy();
    expect(getByText("📊")).toBeTruthy();
    expect(
      getByRole("button", { name: "View Weekly report digest" }),
    ).toBeTruthy();
  });

  test("renders multiple skills as stacked rows in a single card", () => {
    const { container, getByText, getByRole } = renderCard(
      makeSurface({
        data: {
          skills: [
            { skillId: "skill-1", name: "Skill one", description: "First" },
            { skillId: "skill-2", name: "Skill two", description: "Second" },
          ],
        },
      }),
    );

    expect(getByText("Skill one")).toBeTruthy();
    expect(getByText("Skill two")).toBeTruthy();
    // Each row's action carries a skill-specific accessible name.
    expect(getByRole("button", { name: "View Skill one" })).toBeTruthy();
    expect(getByRole("button", { name: "View Skill two" })).toBeTruthy();
    // One card (SurfaceContainer), not one per skill.
    expect(container.querySelectorAll(".rounded-lg")).toHaveLength(1);
  });

  test("View opens the skill detail sidepanel on desktop without leaving the conversation", () => {
    const { getByRole, getByTestId } = renderCard(
      makeSurface({
        data: {
          skills: [
            { skillId: "skill-1", name: "Skill one" },
            { skillId: "skill-2", name: "Skill two" },
          ],
        },
      }),
    );

    fireEvent.click(getByRole("button", { name: "View Skill two" }));

    expect(useViewerStore.getState().mainView).toBe("skill-detail");
    expect(useViewerStore.getState().activeSkillDetailId).toBe("skill-2");
    // The panel opens in place — the conversation route is untouched.
    expect(getByTestId("location").textContent).toBe(
      "/assistant/conversations/conv-xyz",
    );
  });

  test("View navigates to the skill detail page on mobile (no sidepanel on narrow viewports)", () => {
    isMobileRef.value = true;
    const { getByRole, getByTestId } = renderCard(
      makeSurface({
        data: {
          skills: [
            { skillId: "skill-1", name: "Skill one" },
            { skillId: "skill-2", name: "Skill two" },
          ],
        },
      }),
    );

    fireEvent.click(getByRole("button", { name: "View Skill two" }));

    expect(getByTestId("location").textContent).toBe(
      "/assistant/skills/skill-2",
    );
    // The panel path is not taken on mobile.
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeSkillDetailId).toBeNull();
  });

  test("clicking the row body (skill name) opens the skill detail — the whole row is the control, not just the View chip", () => {
    const { getByText } = renderCard(
      makeSurface({
        data: {
          skills: [
            { skillId: "skill-1", name: "Skill one" },
            { skillId: "skill-2", name: "Skill two" },
          ],
        },
      }),
    );

    fireEvent.click(getByText("Skill two"));

    expect(useViewerStore.getState().mainView).toBe("skill-detail");
    expect(useViewerStore.getState().activeSkillDetailId).toBe("skill-2");
  });

  test("skill-creation-card flag gates rendering (kill-switch for already-persisted cards)", () => {
    useClientFeatureFlagStore.setState({ skillCreationCard: false });
    const flagOff = renderCard(makeSurface());
    expect(flagOff.queryByText("New skill learned")).toBeNull();
    flagOff.unmount();

    useClientFeatureFlagStore.setState({ skillCreationCard: true });
    const flagOn = renderCard(makeSurface());
    expect(flagOn.getByText("New skill learned")).toBeTruthy();
  });

  test("falls back to the Brain icon when a skill has no emoji", () => {
    const { container } = renderCard(
      makeSurface({
        data: {
          skills: [{ skillId: "skill-1", name: "No emoji", emoji: null }],
        },
      }),
    );

    expect(container.innerHTML).toContain("lucide-brain");
  });

  test("renders nothing when data.skills is missing", () => {
    const { queryByText } = renderCard(makeSurface({ data: {} }));

    expect(queryByText("New skill learned")).toBeNull();
  });

  test("renders nothing when data.skills is malformed", () => {
    const { queryByText } = renderCard(
      makeSurface({ data: { skills: "not-an-array" } }),
    );

    expect(queryByText("New skill learned")).toBeNull();
  });

  test("drops entries without a usable skillId or name but keeps valid ones", () => {
    const { getByText, queryByText, getAllByRole } = renderCard(
      makeSurface({
        data: {
          skills: [
            { skillId: "skill-1", name: "Valid skill" },
            { name: "Missing id" },
            { skillId: "skill-3", name: 42 },
            "junk",
          ],
        },
      }),
    );

    expect(getByText("Valid skill")).toBeTruthy();
    expect(queryByText("Missing id")).toBeNull();
    expect(getAllByRole("button", { name: /^View / })).toHaveLength(1);
  });
});

describe("SurfaceRouter", () => {
  test("routes skill_card surfaces", () => {
    const { queryByText, getByText } = render(
      <MemoryRouter>
        <SurfaceRouter surface={makeSurface()} onAction={() => {}} />
      </MemoryRouter>,
    );

    expect(queryByText("Unsupported surface type: skill_card")).toBeNull();
    expect(getByText("Weekly report digest")).toBeTruthy();
  });
});
