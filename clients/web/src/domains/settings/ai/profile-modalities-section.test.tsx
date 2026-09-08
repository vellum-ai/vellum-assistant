import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProfileModalitiesSection } from "@/domains/settings/ai/profile-modalities-section";

afterEach(() => {
  cleanup();
});

describe("ProfileModalitiesSection", () => {
  test("keeps the support switch disabled until the modality is enabled", () => {
    const changes: unknown[] = [];
    render(
      <ProfileModalitiesSection
        value={{}}
        onChange={(next) => changes.push(next)}
        isReadOnly={false}
        expanded
        collapsible={false}
      />,
    );

    const supportImage = screen.getByRole("switch", {
      name: "Model supports Image",
    });
    expect(supportImage).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("switch", { name: "Enable Image" }));
    expect(changes[0]).toEqual({
      image: { enabled: true, supported: false },
    });
  });

  test("collapsible trigger starts closed", () => {
    render(
      <ProfileModalitiesSection
        value={{}}
        onChange={() => {}}
        isReadOnly={false}
        expanded={false}
        collapsible
      />,
    );

    const trigger = screen.getByRole("button", { name: "Modalities" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("switch", { name: "Enable Image" }),
    ).toBeNull();
  });
});
