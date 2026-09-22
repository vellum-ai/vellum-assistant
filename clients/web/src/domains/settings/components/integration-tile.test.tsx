import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HoverCapabilityOverride } from "@vellumai/design-library/utils/hover-capability";

import {
  GOOGLE_PROVIDER,
  NOTION_PROVIDER,
  googlePlan,
  linearMcpPlan,
  mcpServer,
  notionPlan,
  planFor,
  pluginDefinition,
} from "../integration-story-fixtures";
import { IntegrationTile, type IntegrationTileProps } from "./integration-tile";

const handlers = {
  onConnect: mock(() => {}),
  onLogin: mock(() => {}),
  onCancel: mock(() => {}),
  onRetry: mock(() => {}),
  onOpenSetupGuide: mock(() => {}),
};

function tile(overrides: Partial<IntegrationTileProps> = {}) {
  return render(
    <IntegrationTile
      {...handlers}
      plan={googlePlan}
      state={{ phase: "idle" }}
      {...overrides}
    />,
  );
}

/** Radix opens a menu on pointer-down, not on a synthetic click. */
function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

afterEach(() => {
  cleanup();
  for (const handler of Object.values(handlers)) {
    handler.mockClear();
  }
});

describe("IntegrationTile", () => {
  test("offers exactly one connect action, named for its integration", () => {
    tile();

    const connect = screen.getByRole("button", { name: "Connect Google" });
    fireEvent.click(connect);
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("keeps the other ways out of sight until they are asked for", () => {
    tile({ plan: notionPlan });

    expect(
      screen.queryByRole("button", { name: "Other ways to connect Notion" }),
    ).toBeNull();
  });

  test("offers every way in behind the chevron when the host picks", async () => {
    tile({
      plan: planFor({
        providers: [NOTION_PROVIDER],
        definitions: [pluginDefinition()],
        ownOAuthAvailable: true,
      }),
      showAlternatives: true,
    });

    openMenu("Other ways to connect Notion");
    for (const label of [
      "Notion MCP server",
      "Sign in through Vellum",
      "Use your own OAuth app",
    ]) {
      await screen.findByRole("menuitem", { name: label });
    }
  });

  test("offers the way back to the recommended path when an alternative fails", async () => {
    const plan = planFor({
      providers: [NOTION_PROVIDER],
      definitions: [pluginDefinition()],
      ownOAuthAvailable: true,
    });
    // The managed sign-in is an alternative here: the provider's own MCP
    // server leads. Failing it must not strand the user on the two ways in
    // that are left.
    const failed = plan.alternatives.find(
      (method) => method.kind === "managed-oauth",
    );
    if (!failed) {
      throw new Error("expected a managed alternative in the fixture plan");
    }
    tile({
      plan,
      showAlternatives: true,
      state: {
        phase: "failed",
        error: "Notion rejected the sign-in.",
        methodId: failed.id,
        methodKind: failed.kind,
      },
    });

    openMenu("Other ways to connect Notion");
    await screen.findByRole("menuitem", { name: "Notion MCP server" });
    await screen.findByRole("menuitem", { name: "Use your own OAuth app" });
    expect(
      screen.queryByRole("menuitem", { name: "Sign in through Vellum" }),
    ).toBeNull();
  });

  test("never offers an MCP server the plugin has already installed", () => {
    const plan = planFor({
      providers: [NOTION_PROVIDER],
      servers: [mcpServer("notion-mcp", { id: "notion" })],
      definitions: [pluginDefinition()],
    });
    const failed = plan.alternatives.find(
      (method) => method.kind === "managed-oauth",
    );
    if (!failed) {
      throw new Error("expected a managed alternative in the fixture plan");
    }
    tile({
      plan,
      state: {
        phase: "failed",
        error: "Notion rejected the sign-in.",
        methodId: failed.id,
        methodKind: failed.kind,
      },
    });

    expect(
      screen.queryByRole("button", { name: "Other ways to connect Notion" }),
    ).toBeNull();
  });

  test("sends a connect with no platform session to the login flow", () => {
    tile({
      plan: planFor({
        providers: [GOOGLE_PROVIDER],
        platformGate: "disabled",
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));
    expect(handlers.onLogin).toHaveBeenCalledTimes(1);
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });

  test("cancels from the action slot once the X is showing", () => {
    tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: true },
    });

    const cancel = screen.getByRole("button", {
      name: "Cancel connecting Notion",
    });
    // A mouse arriving is what turns the spinner into an X, so the click that
    // follows lands on a control the user has already been shown.
    fireEvent.pointerEnter(cancel, { pointerType: "mouse" });
    fireEvent.click(cancel, { detail: 1 });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  test("never throws a sign-in away on a single unwarned tap", () => {
    tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: true },
    });

    // A convertible reports that it can hover because of its trackpad, and is
    // being tapped with a finger anyway. The finger gets no tooltip, so it
    // gets the two-press path: the first reveals the X, the second means it.
    const cancel = screen.getByRole("button", {
      name: "Cancel connecting Notion",
    });
    // A touch tap sends its leave before its click, both times. Acting on
    // that leave would disarm the button between the tap that revealed the X
    // and the tap that meant it, and the sign-in could never be stopped.
    fireEvent.pointerEnter(cancel, { pointerType: "touch" });
    fireEvent.pointerLeave(cancel, { pointerType: "touch" });
    fireEvent.click(cancel, { detail: 1 });
    expect(handlers.onCancel).not.toHaveBeenCalled();

    fireEvent.pointerEnter(cancel, { pointerType: "touch" });
    fireEvent.pointerLeave(cancel, { pointerType: "touch" });
    fireEvent.click(cancel, { detail: 1 });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  test("gives a stylus that cannot hover the same two presses", () => {
    render(
      <HoverCapabilityOverride hoverCapable={false}>
        <IntegrationTile
          {...handlers}
          plan={notionPlan}
          state={{ phase: "waiting", canCancel: true }}
        />
      </HoverCapabilityOverride>,
    );

    // A tablet stylus reports `pen` and still lands on contact, on a device
    // that mounts no tooltip at all. Trusting the pointer type alone would
    // cancel on the press that was only meant to reveal.
    const cancel = screen.getByRole("button", {
      name: "Cancel connecting Notion",
    });
    fireEvent.pointerEnter(cancel, { pointerType: "pen" });
    fireEvent.click(cancel, { detail: 1 });
    expect(handlers.onCancel).not.toHaveBeenCalled();

    fireEvent.click(cancel, { detail: 1 });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  test("lets a mouse leaving take the X back", () => {
    tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: true },
    });

    const cancel = screen.getByRole("button", {
      name: "Cancel connecting Notion",
    });
    fireEvent.pointerEnter(cancel, { pointerType: "mouse" });
    fireEvent.pointerLeave(cancel, { pointerType: "mouse" });
    // The warning left with the pointer, so the next press is unwarned again.
    fireEvent.click(cancel, { detail: 1 });
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  test("cancels on the first keyboard press, with nothing to reveal first", () => {
    tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: true },
    });

    // A keyboard press and a screen reader's activation carry no pointer, so
    // there is no mis-aimed thumb to guard against. Arming here would read as
    // a cancel button that does nothing.
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel connecting Notion" }),
      { detail: 0 },
    );
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  test("offers nothing to press while there is nothing to stop", () => {
    const uncancellable = tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: false },
    });

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    screen.getByText("Finish signing in to Notion in your browser.");

    uncancellable.unmount();
    tile({ plan: notionPlan, state: { phase: "connecting" } });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    screen.getByText("Almost there. Waiting for Notion to become ready.");
  });

  test("says nothing in the tile body while an attempt is in flight", () => {
    const { container } = tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: true },
    });

    // The description is all the body ever holds, whatever the attempt is
    // doing: anything else here would be a line the grid row has to grow for.
    const description = container.querySelector("p.line-clamp-2");
    expect(description?.textContent).toBe(notionPlan.description ?? "");
  });

  test("puts the progress where a thumb can read it with no hover", () => {
    const { container } = render(
      <HoverCapabilityOverride hoverCapable={false}>
        <IntegrationTile
          {...handlers}
          plan={notionPlan}
          state={{ phase: "waiting", canCancel: true }}
        />
      </HoverCapabilityOverride>,
    );

    // No hover means no tooltip at all, so the message takes the description's
    // two reserved lines instead. Still one block, still the same height.
    const blocks = container.querySelectorAll("p.line-clamp-2");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe(
      "Finish signing in to Notion in your browser.",
    );
    // And only once, so a screen reader does not hear it twice.
    expect(
      screen.getAllByText("Finish signing in to Notion in your browser."),
    ).toHaveLength(1);
  });

  test("sends a failed MCP attempt to its setup guide and its alternatives", async () => {
    tile({
      plan: linearMcpPlan,
      state: {
        phase: "failed",
        error: "Linear rejected the sign-in.",
        methodId: linearMcpPlan.primary.id,
        methodKind: "mcp-oauth",
        setupGuideUrl: "https://example.com/docs/linear-mcp",
      },
    });

    screen.getByText("Linear rejected the sign-in.");
    // Both of them behind the retry's chevron, where they cost the tile no
    // height at all.
    openMenu("Other ways to connect Linear");
    await screen.findByRole("menuitem", { name: "Sign in through Vellum" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Setup guide" }));
    expect(handlers.onOpenSetupGuide).toHaveBeenCalledWith(
      "https://example.com/docs/linear-mcp",
    );
  });

  test("spends the description's lines on the failure rather than new ones", () => {
    const { container } = tile({
      plan: googlePlan,
      state: {
        phase: "failed",
        error: "Google did not return an account.",
        methodId: googlePlan.primary.id,
        methodKind: "managed-oauth",
      },
    });

    // One clamped block in the body, holding the error instead of the
    // description. Two blocks would be the row-stretching bug coming back.
    const blocks = container.querySelectorAll("p.line-clamp-2");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe("Google did not return an account.");
    expect(screen.queryByText(googlePlan.description ?? "")).toBeNull();
  });

  test("says what went wrong in the words it was given", () => {
    // The whole fix for this failure is in the sentence, so the tile carries
    // it rather than replacing it with a line that explains nothing.
    const popupBlocked =
      "Your browser blocked the sign-in window. Allow pop-ups and try again.";
    tile({
      state: {
        phase: "failed",
        error: popupBlocked,
        methodId: googlePlan.primary.id,
        methodKind: "managed-oauth",
      },
    });

    screen.getByText(popupBlocked);
  });

  test("clamps a paragraph of provider prose rather than dropping it", () => {
    const paragraph =
      "Google rejected the sign-in because the workspace administrator " +
      "has not granted this application access to the account yet.";
    tile({
      state: {
        phase: "failed",
        error: paragraph,
        methodId: googlePlan.primary.id,
        methodKind: "managed-oauth",
      },
    });

    // Held to the two lines the description had reserved, and reachable whole
    // from the title for the rest.
    const message = screen.getByText(paragraph);
    expect(message.getAttribute("title")).toBe(paragraph);
    expect(message.closest("p")?.className).toContain("line-clamp-2");
    expect(
      screen.queryByText("Sign-in to Google did not complete."),
    ).toBeNull();
  });

  test("falls back to its own line for a failure that arrived with no message", () => {
    tile({
      state: {
        phase: "failed",
        error: "",
        methodId: googlePlan.primary.id,
        methodKind: "managed-oauth",
      },
    });

    const message = screen.getByText("Sign-in to Google did not complete.");
    expect(message.getAttribute("title")).toBeNull();
  });

  test("leaves out a setup guide and a menu that lead nowhere", () => {
    tile({
      state: {
        phase: "failed",
        error: "Google did not return an account.",
        methodId: googlePlan.primary.id,
        methodKind: "managed-oauth",
      },
    });

    expect(
      screen.queryByRole("button", { name: "Other ways to connect Google" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry connecting Google" }),
    );
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });
});
