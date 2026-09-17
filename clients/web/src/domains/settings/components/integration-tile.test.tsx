import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

    openMenu("Try another way");
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
      screen.queryByRole("button", { name: "Try another way" }),
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

  test("offers to stop waiting only while there is something to stop", () => {
    const cancellable = tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);

    cancellable.unmount();
    tile({
      plan: notionPlan,
      state: { phase: "waiting", canCancel: false },
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    expect(handlers.onOpenSetupGuide).toHaveBeenCalledWith(
      "https://example.com/docs/linear-mcp",
    );

    openMenu("Try another way");
    await screen.findByRole("menuitem", { name: "Sign in through Vellum" });
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

    expect(screen.queryByRole("button", { name: "Setup guide" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Try another way" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry connecting Google" }),
    );
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });
});
