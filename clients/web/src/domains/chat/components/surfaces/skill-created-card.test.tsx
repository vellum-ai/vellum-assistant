import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { SkillCreatedCard } from "@/domains/chat/components/surfaces/skill-created-card";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";

afterEach(cleanup);

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

function renderCard(surface: Surface) {
  return render(
    <SkillCreatedCard surface={surface} onAction={() => {}} />,
  );
}

describe("SkillCreatedCard", () => {
  test("renders a single learned-sentence row per skill (no generic header)", () => {
    const { container, getByText, queryByRole, queryByText } = renderCard(
      makeSurface(),
    );

    // The card renders no generic header or subline: each row's title
    // carries the full learned sentence, so a header would double-announce.
    expect(queryByText("New skill learned")).toBeNull();
    expect(
      queryByText("Saved to your skills from this conversation's work"),
    ).toBeNull();
    expect(
      getByText("I just learned how to do Weekly report digest"),
    ).toBeTruthy();
    expect(
      queryByText("Compile the weekly report from the usual sources."),
    ).toBeNull();
    expect(queryByText("📊")).toBeNull();
    expect(queryByText("View")).toBeNull();
    expect(container.querySelector(".lucide-brain")).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
    expect(queryByRole("link")).toBeNull();
  });

  test("renders multiple skills as stacked rows in a single card", () => {
    const { container, getByText, queryByRole } = renderCard(
      makeSurface({
        data: {
          skills: [
            { skillId: "skill-1", name: "Skill one", description: "First" },
            { skillId: "skill-2", name: "Skill two", description: "Second" },
          ],
        },
      }),
    );

    expect(getByText("I just learned how to do Skill one")).toBeTruthy();
    expect(getByText("I just learned how to do Skill two")).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
    // One card (SurfaceContainer), not one per skill.
    expect(container.querySelectorAll(".rounded-lg")).toHaveLength(1);
  });

  test("renders the Brain icon when a skill has no emoji", () => {
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

    expect(queryByText(/I just learned how to do/)).toBeNull();
  });

  test("renders nothing when data.skills is malformed", () => {
    const { queryByText } = renderCard(
      makeSurface({ data: { skills: "not-an-array" } }),
    );

    expect(queryByText(/I just learned how to do/)).toBeNull();
  });

  test("drops entries without a usable skillId or name but keeps valid ones", () => {
    const { getByText, queryByText, getAllByText } = renderCard(
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

    expect(getByText("I just learned how to do Valid skill")).toBeTruthy();
    expect(queryByText(/Missing id/)).toBeNull();
    expect(getAllByText(/^I just learned how to do /)).toHaveLength(1);
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
    expect(
      getByText("I just learned how to do Weekly report digest"),
    ).toBeTruthy();
  });
});
