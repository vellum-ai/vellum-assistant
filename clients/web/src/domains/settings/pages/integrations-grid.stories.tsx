import type { Meta, StoryObj } from "@storybook/react-vite";

import { useTranslation } from "@/i18n";

import { IntegrationRow } from "../components/integration-row";
import {
  IntegrationTile,
  type TileConnectState,
} from "../components/integration-tile";
import type { ConnectPlan } from "../connect-plan";
import { buildIntegrationItems } from "../integration-items";
import {
  ASANA_PROVIDER,
  FIGMA_PROVIDER,
  GITHUB_PROVIDER,
  GOOGLE_PROVIDER,
  NOTION_PROVIDER,
  googlePlan,
  linearMcpPlan,
  notionPlan,
  oauthConnection,
  oauthProvider,
  planFor,
  pluginDefinition,
} from "../integration-story-fixtures";

import {
  AVAILABLE_GRID,
  CONFIGURED_GRID,
  IntegrationSection,
} from "./integrations-page";

const noop = () => {};

const figmaPlan = planFor({ providers: [FIGMA_PROVIDER] });
const asanaPlan = planFor({ providers: [ASANA_PROVIDER] });
const dropboxPlan = planFor({
  providers: [
    oauthProvider("dropbox", "Dropbox", "Files and folders in Dropbox."),
  ],
});

const mcpFailure: TileConnectState = {
  phase: "failed",
  error: "Linear rejected the sign-in.",
  methodId: linearMcpPlan.primary.id,
  methodKind: linearMcpPlan.primary.kind,
  setupGuideUrl: linearMcpPlan.primary.setupGuideUrl,
};

const idle: TileConnectState = { phase: "idle" };

/**
 * The connected section holds integrations the available one does not.
 * Grouped and drawn the way the page does it, so the gear beside a connected
 * account is the one the page ships rather than a copy of it.
 */
const CONNECTED = buildIntegrationItems(
  [
    oauthProvider("outlook", "Outlook", "Mail and calendar from Outlook."),
    oauthProvider("todoist", "Todoist", "Tasks from Todoist."),
    oauthProvider("calendly", "Calendly", "Bookings from your Calendly."),
  ],
  [
    oauthConnection("outlook"),
    oauthConnection("todoist", { id: "conn-todoist-1" }),
    oauthConnection("todoist", { id: "conn-todoist-2" }),
    oauthConnection("calendly", { connected: false, status: "REVOKED" }),
  ],
  [],
  [],
).flatMap((item) => (item.kind === "oauth" ? [item] : []));

/** A page in its ordinary state: one attempt in flight, one that went wrong. */
const AVAILABLE: { plan: ConnectPlan; state: TileConnectState }[] = [
  { plan: googlePlan, state: idle },
  { plan: notionPlan, state: idle },
  { plan: figmaPlan, state: { phase: "waiting", canCancel: true } },
  { plan: asanaPlan, state: idle },
  { plan: linearMcpPlan, state: mcpFailure },
  { plan: dropboxPlan, state: idle },
];

/** The same catalog with no platform session: every managed path is a login. */
const AVAILABLE_LOGGED_OUT = [
  planFor({ providers: [GOOGLE_PROVIDER], platformGate: "disabled" }),
  planFor({ providers: [GITHUB_PROVIDER], platformGate: "disabled" }),
  planFor({ providers: [FIGMA_PROVIDER], platformGate: "disabled" }),
  planFor({ providers: [ASANA_PROVIDER], platformGate: "disabled" }),
].map((plan) => ({ plan, state: idle }));

/**
 * Self-hosted, where registering your own OAuth app is always a path, so
 * every tile has something behind its chevron.
 */
const AVAILABLE_SELF_HOSTED = [
  planFor({ providers: [GOOGLE_PROVIDER], ownOAuthAvailable: true }),
  planFor({
    providers: [NOTION_PROVIDER],
    definitions: [pluginDefinition()],
    ownOAuthAvailable: true,
  }),
  planFor({ providers: [FIGMA_PROVIDER], ownOAuthAvailable: true }),
  planFor({ providers: [ASANA_PROVIDER], ownOAuthAvailable: true }),
  planFor({
    providers: [
      oauthProvider("dropbox", "Dropbox", "Files and folders in Dropbox."),
    ],
    ownOAuthAvailable: true,
  }),
].map((plan) => ({ plan, state: idle }));

function IntegrationsGrid({
  available = AVAILABLE,
  showAlternatives = false,
}: {
  available?: { plan: ConnectPlan; state: TileConnectState }[];
  showAlternatives?: boolean;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="min-h-dvh bg-[var(--surface-overlay)] p-4 md:px-6 md:py-6">
      <div className="space-y-4">
        <IntegrationSection
          title={t("integrationsPage.sectionConfigured")}
          count={CONNECTED.length}
          gridClassName={CONFIGURED_GRID}
        >
          {CONNECTED.map((item) => (
            <IntegrationRow
              key={item.id}
              providerKey={item.provider.provider_key}
              displayName={item.name}
              description={item.description}
              logoUrl={item.provider.logo_url}
              connections={item.connections}
              onConfigure={noop}
            />
          ))}
        </IntegrationSection>

        <IntegrationSection
          title={t("integrationsPage.sectionAvailable")}
          count={available.length}
          gridClassName={AVAILABLE_GRID}
        >
          {available.map(({ plan, state }) => (
            <IntegrationTile
              key={plan.name}
              plan={plan}
              state={state}
              showAlternatives={showAlternatives}
              onConnect={noop}
              onLogin={noop}
              onCancel={noop}
              onRetry={noop}
              onOpenSetupGuide={noop}
            />
          ))}
        </IntegrationSection>
      </div>
    </div>
  );
}

/**
 * The Integrations page with every connect state on screen at once: what the
 * two sections look like side by side, how a tile mid-attempt sits next to one
 * at rest, and what a failure costs its neighbours in height.
 *
 * Static by design. The page's own data hooks need an assistant, and this is
 * here to review the layout the plan drives.
 */
const meta: Meta<typeof IntegrationsGrid> = {
  title: "Settings/IntegrationsGrid",
  component: IntegrationsGrid,
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

export default meta;
type Story = StoryObj<typeof IntegrationsGrid>;

export const Default: Story = {};

/**
 * Signed out of the Vellum platform. The tiles are the ones above, glyph for
 * glyph: the click goes to the login flow instead of to the provider, and no
 * tile spends a line saying so.
 */
export const LoggedOut: Story = {
  render: () => <IntegrationsGrid available={AVAILABLE_LOGGED_OUT} />,
};

/**
 * Self-hosted, where every integration has more than one way in and the user
 * is the one who picks: the connect action carries its chevron.
 */
export const SelfHosted: Story = {
  render: () => (
    <IntegrationsGrid available={AVAILABLE_SELF_HOSTED} showAlternatives />
  ),
};

export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
