/**
 * One-line, high-level stats for the overview's bento cards — a count or
 * one short line per section, nothing more. Every query degrades silently
 * (loading or error → no stat shown) so the overview never blocks or
 * errors on these extras.
 */

import { useQuery } from "@tanstack/react-query";

import {
  completeSliderValues,
  fetchPersonalitySliders,
  personalitySlidersQueryKey,
} from "@/assistant/personality-sliders";
import {
  appsGetOptions,
  channelsReadinessGetOptions,
  contactsGetOptions,
  documentsGetOptions,
  schedulesGetQueryKey,
  skillsGetOptions,
  workspaceTreeGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { installedPluginsQueryOptions } from "@/lib/installed-plugins-query";
import { fetchSchedules } from "@/utils/schedules";

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
  /**
   * Small unit label under the hero numeral ("installed", "people"). Names
   * the unit only; the card supplies the number.
   */
  label?: string;
  /**
   * The stat as one complete line ("34 memories", "Nothing scheduled yet").
   * The mini tile renders this alone, so a countable stat carries it too,
   * as a whole ICU message rather than the numeral and unit joined by hand.
   */
  text?: string;
  /** Persisted personality slider values, drawn as the signature mark. */
  signature?: Record<string, number>;
  /** Upcoming enabled schedules (soonest first) + how many were cut. */
  schedules?: { items: SchedulePreview[]; more: number };
}

/** These are glanceable extras — refresh lazily. */
const STATS_STALE_MS = 60_000;

const SCHEDULE_PREVIEW_COUNT = 3;

interface UseIdentitySectionStatsOptions {
  /** Skip the plugin fetch on assistants without the plugin routes. */
  supportsPlugins: boolean;
  /**
   * Skip the reads behind cards the native mobile shells don't render
   * (see `NATIVE_MOBILE_HIDDEN_KEYS` in `components/identity-sections.ts`).
   */
  isNativeMobile: boolean;
}

export function useIdentitySectionStats(
  assistantId: string,
  { supportsPlugins, isNativeMobile }: UseIdentitySectionStatsOptions,
): Record<string, IdentitySectionStat | undefined> {
  const { t } = useTranslation("intelligence");
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
    select: (data) => data.plugins.length,
    enabled: supportsPlugins,
  });
  const apps = useQuery({
    ...appsGetOptions({ path }),
    select: (data) => data.apps.length,
    ...common,
  });
  const documents = useQuery({
    ...documentsGetOptions({ path }),
    select: (data) => data.documents.length,
    ...common,
  });
  const workspace = useQuery({
    ...workspaceTreeGetOptions({ path }),
    select: (data) => data.entries.length,
    ...common,
    enabled: !isNativeMobile,
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
  // refreshes the card's signature too.
  const sliders = useQuery({
    queryKey: personalitySlidersQueryKey(assistantId),
    queryFn: () => fetchPersonalitySliders(assistantId),
    ...common,
  });

  return {
    personality: {
      // `null` means the sidecar was never persisted (onboarded before it
      // was saved, or never touched the sliders) — fall back to the
      // all-centered flat line instead of a blank card. `undefined`
      // covers still-loading and read errors, which stay a no-stat card so a
      // transient failure never overwrites saved dials with a neutral mark.
      signature:
        sliders.data !== undefined
          ? completeSliderValues(sliders.data ?? {})
          : undefined,
    },
    // Skills and plugins share the merged Superpowers card, and the tile
    // states them as one total rather than two counts. Until the plugin
    // query resolves, and forever on assistants without the plugin surface,
    // that total would understate itself, so the stat stays skills-only.
    superpowers:
      skills.data !== undefined
        ? {
            text:
              plugins.data !== undefined
                ? t("useIdentitySectionStats.skillAndPluginCount", {
                    count: skills.data + plugins.data,
                  })
                : t("useIdentitySectionStats.skillCount", {
                    count: skills.data,
                  }),
          }
        : undefined,
    // Apps and documents share the Library card and read as one total, on
    // the same terms as the superpowers stat above: apps alone until the
    // document read resolves.
    library:
      apps.data !== undefined
        ? {
            text:
              documents.data !== undefined
                ? t("useIdentitySectionStats.appAndDocCount", {
                    count: apps.data + documents.data,
                  })
                : t("useIdentitySectionStats.appCount", { count: apps.data }),
          }
        : undefined,
    workspace:
      workspace.data !== undefined
        ? {
            value: workspace.data,
            label: t("useIdentitySectionStats.itemLabel", {
              count: workspace.data,
            }),
            text: t("useIdentitySectionStats.itemCount", {
              count: workspace.data,
            }),
          }
        : undefined,
    contacts:
      contacts.data !== undefined
        ? {
            value: contacts.data,
            label: t("useIdentitySectionStats.personLabel", {
              count: contacts.data,
            }),
            text: t("useIdentitySectionStats.personCount", {
              count: contacts.data,
            }),
          }
        : undefined,
    channels:
      channels.data !== undefined
        ? {
            value: channels.data,
            label: t("useIdentitySectionStats.connectedLabel", {
              count: channels.data,
            }),
            text: t("useIdentitySectionStats.connectedCount", {
              count: channels.data,
            }),
          }
        : undefined,
    schedules:
      schedules.data !== undefined
        ? schedules.data.count === 0
          ? { text: t("useIdentitySectionStats.noSchedulesText") }
          : {
              value: schedules.data.count,
              label: t("useIdentitySectionStats.activeLabel", {
                count: schedules.data.count,
              }),
              text: t("useIdentitySectionStats.activeCount", {
                count: schedules.data.count,
              }),
              schedules: {
                items: schedules.data.items,
                more: schedules.data.count - schedules.data.items.length,
              },
            }
        : undefined,
  };
}
