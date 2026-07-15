/**
 * One-line, high-level stats for the overview's bento cards — a count or a
 * few chips per section, nothing more. Every query degrades silently
 * (loading or error → no stat shown) so the overview never blocks or
 * errors on these extras.
 */

import { useQuery } from "@tanstack/react-query";

import {
  channelsReadinessGetOptions,
  contactsGetOptions,
  schedulesGetQueryKey,
  skillsGetOptions,
  workspaceTreeGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { installedPluginsQueryOptions } from "@/lib/installed-plugins-query";
import { fetchSchedules } from "@/utils/schedules";

import {
  completeSliderValues,
  fetchPersonalitySliders,
  personalitySlidersQueryKey,
} from "./identity-actions/personality-sliders";

export interface SchedulePreview {
  id: string;
  name: string;
  /** Human-readable frequency ("Every weekday at 9am"). */
  cadence: string;
  /** Next fire time, epoch ms. */
  nextRunAt: number;
}

export interface IdentitySectionStat {
  /** Hero numeral, rendered display-size on the card. */
  value?: number;
  /** Small unit label under the hero numeral ("installed", "people"). */
  label?: string;
  /** Plain one-liner for sections without a countable stat. */
  text?: string;
  chips?: string[];
  /** Persisted personality slider values, plotted as a radar chart. */
  radar?: Record<string, number>;
  /** Upcoming enabled schedules (soonest first) + how many were cut. */
  schedules?: { items: SchedulePreview[]; more: number };
}

/** These are glanceable extras — refresh lazily. */
const STATS_STALE_MS = 60_000;

const PLUGIN_CHIP_COUNT = 3;
const SCHEDULE_PREVIEW_COUNT = 3;

function pluralLabel(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

interface UseIdentitySectionStatsOptions {
  /** Skip the plugin fetch on assistants without the plugin routes. */
  supportsPlugins: boolean;
  /** Skip the channels fetch while the Channels surface is flagged off. */
  showChannels: boolean;
}

export function useIdentitySectionStats(
  assistantId: string,
  { supportsPlugins, showChannels }: UseIdentitySectionStatsOptions,
): Record<string, IdentitySectionStat | undefined> {
  const path = { assistant_id: assistantId };
  const common = { staleTime: STATS_STALE_MS, retry: false, enabled: true };

  const skills = useQuery({
    ...skillsGetOptions({ path, query: { kind: "installed" } }),
    select: (data) => data.skills.length,
    ...common,
  });
  // Shares the canonical installed-plugins cache entry (see
  // `lib/installed-plugins-query.ts`) — registering the same key with a
  // different queryFn shape would poison the cache for the other readers.
  const plugins = useQuery({
    ...installedPluginsQueryOptions(assistantId),
    select: (data) =>
      data.plugins
        .filter((p) => p.enabled)
        .slice(0, PLUGIN_CHIP_COUNT)
        .map((p) => p.name),
    enabled: supportsPlugins,
  });
  const workspace = useQuery({
    ...workspaceTreeGetOptions({ path }),
    select: (data) => data.entries.length,
    ...common,
  });
  const contacts = useQuery({
    ...contactsGetOptions({ path }),
    select: (data) => data.contacts.length,
    ...common,
  });
  const channels = useQuery({
    ...channelsReadinessGetOptions({ path }),
    select: (data) => data.snapshots.filter((s) => s.ready).length,
    ...common,
    enabled: showChannels,
  });
  // Shares the schedules cache entry owned by `fetchSchedules` (Settings
  // and the Activity page key it identically with a `Schedule[]` payload)
  // — registering the generated options' raw `{schedules}` shape under the
  // same key crashes those pages when they read our cached copy.
  const schedules = useQuery({
    queryKey: schedulesGetQueryKey({ path }),
    queryFn: () => fetchSchedules(assistantId),
    select: (data) => {
      const enabled = data
        .filter((s) => s.enabled)
        .sort((a, b) => a.nextRunAt - b.nextRunAt);
      return {
        count: enabled.length,
        items: enabled.slice(0, SCHEDULE_PREVIEW_COUNT).map((s) => ({
          id: s.id,
          name: s.name,
          cadence: s.cadenceDescription,
          nextRunAt: s.nextRunAt,
        })),
      };
    },
    ...common,
  });
  // Shares the personality page's query key, so applying an update there
  // refreshes the card's radar too.
  const sliders = useQuery({
    queryKey: personalitySlidersQueryKey(assistantId),
    queryFn: () => fetchPersonalitySliders(assistantId),
    ...common,
  });

  return {
    personality: {
      radar: sliders.data ? completeSliderValues(sliders.data) : undefined,
    },
    skills:
      skills.data !== undefined
        ? { value: skills.data, label: "installed" }
        : undefined,
    plugins:
      plugins.data !== undefined
        ? plugins.data.length > 0
          ? { chips: plugins.data }
          : { text: "None yet" }
        : undefined,
    workspace:
      workspace.data !== undefined
        ? {
            value: workspace.data,
            label: pluralLabel(workspace.data, "item", "items"),
          }
        : undefined,
    contacts:
      contacts.data !== undefined
        ? {
            value: contacts.data,
            label: pluralLabel(contacts.data, "person", "people"),
          }
        : undefined,
    channels:
      channels.data !== undefined
        ? { value: channels.data, label: "connected" }
        : undefined,
    schedules:
      schedules.data !== undefined
        ? {
            value: schedules.data.count,
            label: "active",
            schedules: {
              items: schedules.data.items,
              more: schedules.data.count - schedules.data.items.length,
            },
          }
        : undefined,
  };
}
