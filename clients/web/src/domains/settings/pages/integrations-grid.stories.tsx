import type { Meta, StoryObj } from "@storybook/react-vite";
import { FilterChip } from "@vellumai/design-library/components/filter-chip";
import { Input } from "@vellumai/design-library/components/input";
import { Search } from "lucide-react";
import { useState } from "react";

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

/**
 * Every connect state in one grid row, which is where the height of a tile
 * stops being the tile's own business: a grid row stretches to its tallest
 * cell, so a line of status text on one tile used to push empty space into
 * all four of its neighbours.
 *
 * The short description is deliberate. The body reserves two lines whether or
 * not there are two to put in them, so a one-line tile and a two-line tile
 * are the same height and the row never moves when one of them changes.
 */
const AVAILABLE_EVERY_STATE: { plan: ConnectPlan; state: TileConnectState }[] =
  [
    { plan: googlePlan, state: idle },
    {
      plan: planFor({
        providers: [oauthProvider("todoist", "Todoist", "Tasks from Todoist.")],
      }),
      state: { phase: "waiting", canCancel: true },
    },
    { plan: asanaPlan, state: { phase: "connecting" } },
    { plan: linearMcpPlan, state: mcpFailure },
    {
      plan: figmaPlan,
      state: {
        phase: "failed",
        error:
          "Figma rejected the sign-in because the workspace administrator " +
          "has not granted this application access to the account yet.",
        methodId: figmaPlan.primary.id,
        methodKind: "managed-oauth",
      },
    },
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

/**
 * The category row the page draws under its search: one chip per category the
 * catalog files something under, with the whole count. Static labels and
 * counts, since the story's fixtures are plans rather than catalog items.
 */
const CATEGORY_CHIPS = [
  { key: "productivity", label: "Productivity", count: 14 },
  { key: "communication", label: "Communication", count: 4 },
  { key: "meetings", label: "Meetings", count: 6 },
  { key: "sales", label: "Sales & CRM", count: 5 },
  { key: "marketing", label: "Marketing", count: 7 },
  { key: "finance", label: "Finance", count: 9 },
  { key: "commerce", label: "Commerce", count: 3 },
  { key: "engineering", label: "Engineering", count: 6 },
  { key: "knowledge", label: "Knowledge", count: 3 },
  { key: "recruiting", label: "Recruiting", count: 3 },
];

function IntegrationsToolbar() {
  const { t } = useTranslation("settings");
  const [category, setCategory] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <Input
        placeholder={t("integrationsPage.searchPlaceholder")}
        aria-label={t("integrationsPage.searchAriaLabel")}
        leftIcon={<Search aria-hidden className="size-4" />}
        className="min-h-11"
        fullWidth
      />
      <div
        role="group"
        aria-label={t("integrationsPage.categoriesLabel")}
        className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
      >
        {CATEGORY_CHIPS.map((chip) => (
          <FilterChip
            key={chip.key}
            selected={category === chip.key}
            count={chip.count}
            onClick={() => setCategory(category === chip.key ? null : chip.key)}
          >
            {chip.label}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}

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
        <IntegrationsToolbar />
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
 * Idle, waiting, connecting, and two failures in one row. Every card is the
 * same height, and a tile that goes idle -> waiting -> idle moves nothing
 * around it: this is the story to check the fix against.
 */
export const EveryConnectState: Story = {
  render: () => <IntegrationsGrid available={AVAILABLE_EVERY_STATE} />,
};

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
