/**
 * The backups table on the Doctor and debug panels: one row per snapshot with
 * its name and a copy button, a type tag, a ready or pending tag, the creation
 * time, and a restore button that stays disabled until the snapshot is ready.
 * The component fetches its own rows from both the daemon and the platform, so
 * `beforeEach` answers those two reads from fixtures through each generated
 * client's `fetch`. The stories cover a populated list, with enough
 * point-in-time backups to show the rotation notice, and an assistant with no
 * backups yet.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AssistantBackup } from "@/assistant/api";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { client as platformClient } from "@/generated/api/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import type { BackupsGetResponse } from "@/generated/daemon/types.gen";
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";

const ASSISTANT_IDS = {
  established: "story-assistant",
  fresh: "story-assistant-fresh",
} as const;

const BACKUPS: AssistantBackup[] = [
  {
    snapshot_name: "story-assistant-pit-20260916-2210",
    pvc: "story-assistant-data",
    created_at: "2026-09-16T22:10:00Z",
    ready_to_use: false,
    backup_type: "point_in_time",
  },
  {
    snapshot_name: "story-assistant-pit-20260915-0904",
    pvc: "story-assistant-data",
    created_at: "2026-09-15T09:04:00Z",
    ready_to_use: true,
    backup_type: "point_in_time",
  },
  {
    snapshot_name: "story-assistant-pit-20260912-1731",
    pvc: "story-assistant-data",
    created_at: "2026-09-12T17:31:00Z",
    ready_to_use: true,
    backup_type: "point_in_time",
  },
  {
    snapshot_name: "story-assistant-scheduled-20260916-0300",
    pvc: "story-assistant-data",
    created_at: "2026-09-16T03:00:00Z",
    ready_to_use: true,
    backup_type: "scheduled",
  },
  {
    snapshot_name: "story-assistant-preview-20260914-1145",
    pvc: "story-assistant-data",
    created_at: "2026-09-14T11:45:00Z",
    ready_to_use: true,
    backup_type: "preview_channel",
  },
  {
    snapshot_name: "story-assistant-doctor-20260913-0812",
    pvc: "story-assistant-data",
    created_at: "2026-09-13T08:12:00Z",
    ready_to_use: false,
    backup_type: "doctor",
  },
];

/** The daemon's side of the list, with nothing stored locally or offsite. */
const DAEMON_BACKUPS: BackupsGetResponse = {
  local: [],
  offsite: [],
  offsiteEnabled: false,
  nextRunAt: null,
};

function backupsFor(pathname: string): AssistantBackup[] {
  return pathname.startsWith(`/v1/assistants/${ASSISTANT_IDS.fresh}/`)
    ? []
    : BACKUPS;
}

/** Answers the platform's `GET /v1/assistants/{id}/backups/`. */
async function platformFetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/backups/") && request.method === "GET") {
    return Response.json({ backups: backupsFor(pathname) });
  }
  return fixtureNotFound();
}

/** Answers the daemon's `GET /v1/assistants/{id}/backups`. */
async function daemonFetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/backups") && request.method === "GET") {
    return Response.json(DAEMON_BACKUPS satisfies BackupsGetResponse);
  }
  return fixtureNotFound();
}

const meta = {
  title: "Settings/AssistantBackups",
  component: AssistantBackups,
  parameters: {
    layout: "padded",
  },
  args: {
    assistantId: ASSISTANT_IDS.established,
  },
  argTypes: {
    assistantId: {
      control: "radio",
      options: Object.values(ASSISTANT_IDS),
    },
  },
  beforeEach: () => {
    const restorePlatform = stubClientFetch(platformClient, platformFetch);
    const restoreDaemon = stubClientFetch(daemonClient, daemonFetch);
    return () => {
      restorePlatform();
      restoreDaemon();
    };
  },
  decorators: [
    (Story) => (
      <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AssistantBackups>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every backup type and both readiness states. Three point-in-time backups
 * exist, so the notice that the next one replaces the oldest sits beside the
 * create button.
 */
export const Populated: Story = {};

/** No backups yet: the create button above the empty message. */
export const Empty: Story = {
  args: {
    assistantId: ASSISTANT_IDS.fresh,
  },
};
