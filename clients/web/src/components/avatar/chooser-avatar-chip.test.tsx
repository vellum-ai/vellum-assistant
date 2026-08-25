import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import type * as BundledHookModule from "@/utils/use-bundled-avatar-components";

const componentsRef: { value: CharacterComponents | null } = { value: null };

mock.module(
  "@/utils/use-bundled-avatar-components",
  (): Partial<typeof BundledHookModule> => ({
    useBundledAvatarComponents: () => componentsRef.value,
  }),
);

const { ChooserAvatarChip } =
  await import("@/components/avatar/chooser-avatar-chip");

const TRAITS: CharacterTraits = {
  bodyShape: BUNDLED_COMPONENTS.bodyShapes[0]!.id,
  eyeStyle: BUNDLED_COMPONENTS.eyeStyles[0]!.id,
  color: BUNDLED_COMPONENTS.colors[0]!.id,
};

const fallback = <span data-testid="fallback">V</span>;

describe("ChooserAvatarChip", () => {
  beforeEach(() => {
    componentsRef.value = BUNDLED_COMPONENTS;
  });

  afterEach(cleanup);

  test("renders the character SVG once components resolve", () => {
    componentsRef.value = null;
    const { container, rerender, queryByTestId } = render(
      <ChooserAvatarChip traits={TRAITS} imageUrl={null} fallback={fallback} />,
    );
    expect(queryByTestId("fallback")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();

    componentsRef.value = BUNDLED_COMPONENTS;
    rerender(
      <ChooserAvatarChip traits={TRAITS} imageUrl={null} fallback={fallback} />,
    );
    expect(queryByTestId("fallback")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  test("character outranks image and honors size", () => {
    const { container } = render(
      <ChooserAvatarChip
        traits={TRAITS}
        imageUrl="https://example.test/a.png"
        size={32}
        fallback={fallback}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.width).toBe("32px");
    expect(root.style.height).toBe("32px");
  });

  test("renders the image when there are no traits", () => {
    const { container } = render(
      <ChooserAvatarChip
        traits={null}
        imageUrl="https://example.test/a.png"
        fallback={fallback}
      />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.test/a.png");
    expect(img?.getAttribute("alt")).toBe("Assistant avatar");
    expect(img?.className).toContain("rounded-full");
    expect(img?.style.width).toBe("48px");
  });

  test("renders the fallback when there is no avatar", () => {
    const { container, queryByTestId } = render(
      <ChooserAvatarChip traits={null} imageUrl={null} fallback={fallback} />,
    );
    expect(queryByTestId("fallback")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
