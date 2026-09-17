import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import {
  GOOGLE_PROVIDER,
  NOTION_PROVIDER,
  googlePlan,
  linearMcpPlan,
  notionPlan,
  planFor,
  pluginDefinition,
} from "../integration-story-fixtures";

import { IntegrationTile, type TileConnectState } from "./integration-tile";

const noop = () => {};

/** Notion on a self-hosted assistant: MCP, Vellum's sign-in, or your own app. */
const selfHostedNotionPlan = planFor({
  providers: [NOTION_PROVIDER],
  definitions: [pluginDefinition()],
  ownOAuthAvailable: true,
});

/** What a rejected sign-in leaves on the tile: one line and a retry. */
const mcpFailure: TileConnectState = {
  phase: "failed",
  error: "Linear rejected the sign-in.",
  methodId: linearMcpPlan.primary.id,
  methodKind: linearMcpPlan.primary.kind,
  setupGuideUrl: linearMcpPlan.primary.setupGuideUrl,
};

/**
 * The tile is where connecting happens now: one `+` starts the recommended
 * path, and the waiting and the failing both land inside the tile instead of
 * in a modal held open over the page.
 *
 * Every story frames the tile at the width its grid column gives it, so a
 * status line or an error line that does not fit shows up here rather than on
 * the page.
 */
const meta: Meta<typeof IntegrationTile> = {
  // Not `centered`: that shrink-wraps the story root, and both layouts are
  // sized by the grid column they sit in rather than by their own contents.
  parameters: { layout: "padded" },
  title: "Settings/IntegrationTile",
  component: IntegrationTile,
  args: {
    plan: googlePlan,
    state: { phase: "idle" },
    layout: "tile",
    showAlternatives: false,
    onConnect: noop,
    onLogin: noop,
    onCancel: noop,
    onRetry: noop,
    onOpenSetupGuide: noop,
  },
  argTypes: {
    plan: { control: false },
    state: { control: false },
    layout: { control: "inline-radio", options: ["tile", "row"] },
  },
  decorators: [
    (Story, context) => (
      <div
        className={
          context.args.layout === "row"
            ? "w-full max-w-[22rem]"
            : "w-full max-w-60"
        }
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof IntegrationTile>;

/** One path to connect, and the one action that starts it. */
export const Idle: Story = {};

/**
 * Notion can also be connected through Vellum's hosted sign-in, and the tile
 * says nothing about it: the alternatives only earn their place once the
 * recommended path has actually failed.
 */
export const IdleWithAlternatives: Story = { args: { plan: notionPlan } };

/**
 * Self-hosted, where the choice between the three paths is a real one: the
 * plus still connects the recommended path, and the chevron beside it opens
 * all three, the recommended one first.
 */
export const IdleSelfHosted: Story = {
  args: {
    plan: selfHostedNotionPlan,
    showAlternatives: true,
  },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Other ways to connect Notion",
      }),
    );
    for (const label of [
      "Notion MCP server",
      "Sign in through Vellum",
      "Use your own OAuth app",
    ]) {
      await expect(
        await screen.findByRole("menuitem", { name: label }),
      ).toBeInTheDocument();
    }
  },
};

/**
 * Without a platform session the tile is the one above, glyph for glyph: the
 * page carries the explanation once, and the click goes to the login flow
 * instead of to the provider.
 */
export const LoginRequired: Story = {
  args: {
    plan: planFor({
      providers: [GOOGLE_PROVIDER],
      platformGate: "disabled",
    }),
  },
};

/** Sign-in has moved to the browser, and the tile holds the user's place. */
export const Waiting: Story = {
  args: { plan: notionPlan, state: { phase: "waiting", canCancel: true } },
};

/** The grant landed; the server is coming up, and there is nothing to cancel. */
export const Connecting: Story = {
  args: { plan: notionPlan, state: { phase: "connecting" } },
};

/**
 * A failure costs one line and turns the connect action into a retry. The
 * provider's own setup guide carries what it requires, and the paths that
 * were hidden until now are under "Try another way".
 */
export const FailedMcp: Story = {
  args: { plan: linearMcpPlan, state: mcpFailure },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("button", { name: "Try another way" }),
    );
    await expect(
      await screen.findByRole("menuitem", { name: "Sign in through Vellum" }),
    ).toBeInTheDocument();
  },
};

/** Vellum's own sign-in has no provider setup guide and nowhere else to go. */
export const FailedManaged: Story = {
  args: {
    state: {
      phase: "failed",
      error: "Google did not return an account.",
      methodId: googlePlan.primary.id,
      methodKind: "managed-oauth",
    },
  },
};

/** The wider presentation the connected section uses. */
export const RowLayout: Story = {
  args: { plan: notionPlan, layout: "row" },
};

export const Mobile: Story = {
  args: { plan: linearMcpPlan, state: mcpFailure },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
