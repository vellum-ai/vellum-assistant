import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { CreatureFooter } from "./creature-footer";

afterEach(() => {
  cleanup();
});

describe("CreatureFooter", () => {
  test("renders the decorative image", () => {
    const { container } = render(<CreatureFooter />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("src")).toMatch(/login-background-characters\.svg$/);
  });

  test("pins the container to the physical bottom with `fixed` (not `absolute`)", () => {
    const { container } = render(<CreatureFooter />);
    const footer = container.querySelector("div");
    expect(footer?.className).toContain("fixed");
    expect(footer?.className).toContain("bottom-0");
    expect(footer?.className).not.toContain("absolute");
  });

  test("forwards a passed className", () => {
    const { container } = render(<CreatureFooter className="test-extra" />);
    const footer = container.querySelector("div");
    expect(footer?.className).toContain("test-extra");
  });

  test("is decorative and non-interactive", () => {
    const { container } = render(<CreatureFooter />);
    const footer = container.querySelector("div");
    expect(footer?.getAttribute("aria-hidden")).toBe("true");
    expect(footer?.className).toContain("pointer-events-none");
  });
});
