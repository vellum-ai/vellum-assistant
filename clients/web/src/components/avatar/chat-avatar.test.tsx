/**
 * ChatAvatar matches ChooserAvatarChip on unknown trait ids: a sidecar that
 * names a body, eyes, or color the served palette does not carry is not a
 * character. The identity page and chat transcript both render this component.
 *
 * bun test src/components/avatar/chat-avatar.test.tsx
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

const TRAITS: CharacterTraits = {
  bodyShape: BUNDLED_COMPONENTS.bodyShapes[0]!.id,
  eyeStyle: BUNDLED_COMPONENTS.eyeStyles[0]!.id,
  color: BUNDLED_COMPONENTS.colors[0]!.id,
};

const UNKNOWN_TRAITS: CharacterTraits = {
  bodyShape: "no-such-body",
  eyeStyle: "no-such-eyes",
  color: "no-such-color",
};

describe("ChatAvatar", () => {
  afterEach(cleanup);

  test("renders the character SVG for traits the palette carries", () => {
    const { container } = render(
      <ChatAvatar
        components={BUNDLED_COMPONENTS}
        traits={TRAITS}
        customImageUrl={null}
        size={56}
      />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("unknown trait ids fall through to the uploaded image", () => {
    const { container } = render(
      <ChatAvatar
        components={BUNDLED_COMPONENTS}
        traits={UNKNOWN_TRAITS}
        customImageUrl="https://example.test/a.png"
        size={56}
      />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.test/a.png",
    );
  });

  test("retired body shape stout-pour falls through instead of throwing", () => {
    const { container } = render(
      <ChatAvatar
        components={BUNDLED_COMPONENTS}
        traits={{
          bodyShape: "stout-pour",
          eyeStyle: TRAITS.eyeStyle,
          color: TRAITS.color,
        }}
        customImageUrl={null}
        size={56}
      />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("V");
  });

  test("unknown trait ids with no image render the letter fallback", () => {
    const { container } = render(
      <ChatAvatar
        components={BUNDLED_COMPONENTS}
        traits={UNKNOWN_TRAITS}
        customImageUrl={null}
        size={56}
      />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("V");
  });
});
