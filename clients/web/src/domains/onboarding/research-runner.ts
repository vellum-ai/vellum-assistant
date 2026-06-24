/**
 * Runs the "research me" turn against the hatched assistant from inside the
 * research-onboarding route and surfaces the parsed `{ claims, suggestions }`
 * incrementally so the in-flow result steps can render real data.
 *
 * SPIKE — research-onboarding flow.
 *
 * Why this lives here (and not in the chat domain): the new in-flow result
 * steps render the research output WITH the toned backdrop, never handing off
 * to the chat surface until the user picks a suggestion. So we fire the turn
 * ourselves — mint a dedicated side conversation, post the research prompt, and
 * poll `messagesGet` — rather than relying on `ActiveChatView`'s stream. Talks
 * to the daemon through the generated SDK directly (`@/domains/chat/api/*` is
 * import-banned from onboarding), exactly like `checkin-scheduler.ts`. The
 * parser is shared via the neutral `@/utils/research-facts`.
 *
 * Best-effort: a failure never blocks the flow — the steps just fall back to
 * their loading/empty presentation. The research conversation is intentionally
 * SEPARATE from the user-facing chat the suggestion click later opens.
 */

import { useCallback, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
  conversationsPost,
  messagesGet,
  messagesPost,
  pluginsInstallPost,
  pluginsSearchGet,
} from "@/generated/daemon/sdk.gen";
import { archiveResearchConversation } from "@/domains/onboarding/archive-research-conversation";
import { invalidateConversationQueries } from "@/utils/conversation-cache";
import type {
  MessagesGetResponses,
  MessagesPostData,
  PluginsSearchGetResponses,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  buildResearchPrompt,
  type AvailableCapability,
  type ResearchSubject,
} from "@/domains/onboarding/research-prompt";
import { resolveDeterministicPlugins } from "@/domains/onboarding/onboarding-plugin-affinity";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  parseResearchResultStreaming,
  type ResearchFact,
  type ResearchSuggestion,
} from "@/utils/research-facts";

/** Poll cadence + ceiling for reading the streaming research reply. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 120_000;
/**
 * Consecutive identical non-empty reads that mark the turn settled once the
 * reply has parsed as a COMPLETE JSON payload. Two matching polls (~3s apart)
 * means generation has stopped, whether the daemon persists the assistant
 * message incrementally or only on completion.
 */
const STABLE_READS_TO_SETTLE = 2;

export function shouldSettleResearchPoll({
  complete,
  stableReads,
}: {
  complete: boolean;
  stableReads: number;
}): boolean {
  return complete && stableReads >= STABLE_READS_TO_SETTLE;
}
/**
 * Org that owns first-party, reviewed Vellum plugins. Onboarding only ever
 * surfaces and installs plugins from this owner — never third-party/external
 * marketplace repos — so a new user is never offered (or silently handed)
 * community code during onboarding.
 */
const VELLUM_PLUGIN_OWNER = "vellum-ai";

/**
 * Vellum-hosted plugins that are still infrastructure/meta rather than a
 * capability worth offering a new user (a reference memory sample, the
 * self-edit diff card). Dropped on top of the owner filter. Anything else owned
 * by Vellum — including future persona plugins like a developer/PM kit — flows
 * through automatically.
 */
const NON_RECOMMENDABLE_PLUGINS = new Set<string>(["simple-memory", "level-up"]);

type CatalogMatch = NonNullable<
  PluginsSearchGetResponses[200]["matches"]
>[number];

export interface RecommendableCapabilities {
  capabilities: AvailableCapability[];
  /** Valid install names, used to gate background installs against hallucination. */
  validNames: Set<string>;
}

/** Keep injected descriptions to one short clause so the prompt stays compact. */
function compactDescription(raw: string): string {
  const firstSentence = raw.trim().split(/(?<=\.)\s/)[0]?.trim() ?? raw.trim();
  return firstSentence.length > 100
    ? `${firstSentence.slice(0, 97).trimEnd()}…`
    : firstSentence;
}

/** Owner segment of an `owner/repo` locator, or "" when unparseable. */
function repoOwner(repo: string | undefined): string {
  return repo?.split("/")[0]?.trim() ?? "";
}

/**
 * Narrow the marketplace catalog to the capabilities onboarding will surface:
 * Vellum-hosted (first-party, reviewed) plugins only, minus the meta/infra
 * ones, each compacted to one short line. Pure so it's unit-testable without
 * mocking the catalog fetch.
 */
export function selectRecommendableCapabilities(
  matches: CatalogMatch[],
): RecommendableCapabilities {
  const capabilities: AvailableCapability[] = [];
  const validNames = new Set<string>();
  for (const m of matches) {
    const name = m.name?.trim();
    const description = m.description?.trim();
    if (!name || !description) continue;
    if (repoOwner(m.source?.repo) !== VELLUM_PLUGIN_OWNER) continue;
    if (NON_RECOMMENDABLE_PLUGINS.has(name)) continue;
    validNames.add(name);
    capabilities.push({ name, description: compactDescription(description) });
  }
  return { capabilities, validNames };
}

const EMPTY_CAPABILITIES: RecommendableCapabilities = {
  capabilities: [],
  validNames: new Set<string>(),
};

/**
 * Pull the live marketplace catalog and compact it into the capability list the
 * research prompt advertises. Best-effort: any failure yields an empty list, in
 * which case the prompt simply omits the capabilities block (unchanged from the
 * pre-plugin behavior).
 */
async function fetchAvailableCapabilities(
  assistantId: string,
): Promise<RecommendableCapabilities> {
  try {
    const res = await pluginsSearchGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    return selectRecommendableCapabilities(res.data?.matches ?? []);
  } catch (err) {
    captureError(err, { context: "research_onboarding_catalog" });
    return { capabilities: [], validNames: new Set<string>() };
  }
}

/**
 * Materialize a matched plugin under the assistant's workspace so the fresh
 * conversation the suggestion click opens can discover its skills (plugin-
 * resident skills load per-conversation from disk — no restart needed; the
 * plugin's hooks/persona would need a later restart, but the skills carry the
 * value). Best-effort and idempotent: an already-installed plugin returns 409,
 * which we ignore.
 */
async function installCapabilityBestEffort(
  assistantId: string,
  name: string,
): Promise<void> {
  try {
    await pluginsInstallPost({
      path: { assistant_id: assistantId },
      body: { name },
      throwOnError: false,
    });
  } catch (err) {
    captureError(err, { context: "research_onboarding_install" });
  }
}

export type ResearchStatus = "idle" | "running" | "done" | "error";

export interface ResearchRunnerState {
  status: ResearchStatus;
  claims: ResearchFact[];
  suggestions: ResearchSuggestion[];
  /**
   * Capabilities being installed for the assistant this run — the deterministic
   * floor (always-install baseline + role affinity) unioned with the model's
   * top-level `plugins` picks, each narrowed to names present in the fetched
   * catalog. Persona-level (not tied to a suggestion); surfaced so the UI can
   * confirm what was set up. Empty when plugins are disabled or nothing fit.
   */
  installedPlugins: string[];
}

export interface StartResearchOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  subject: ResearchSubject;
  /** Friendly title for the behind-the-scenes research conversation. */
  conversationTitle?: string;
}

export interface UseResearchRunner extends ResearchRunnerState {
  /**
   * Fire the research turn. Keyed by subject: calling again with the same
   * subject is a no-op, but resubmitting with EDITED details (e.g. the user
   * stepped back and changed their name/role) restarts the run and cancels the
   * stale poll loop so the results reflect the corrected subject.
   */
  start: (options: StartResearchOptions) => void;
  /**
   * Block a suggestion click only as long as the persona plugins need: waits for
   * the `plugins` decision to be final (so a click that beat the parse doesn't
   * skip selection), then for those installs to finish — never for the rest of
   * the research turn. Resolves instantly when nothing is installable (plugins
   * disabled, none picked, or already installed), so ordinary clicks don't hang.
   */
  awaitPluginInstalls: () => Promise<void>;
}

type GetMessage = MessagesGetResponses[200]["messages"][number];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded wait (ms) for the assistant flag store to hydrate before gating on it. */
const FLAG_HYDRATE_TIMEOUT_MS = 8000;

/**
 * Whether the experimental external-plugin surface is enabled for this
 * assistant. Plugin install/load lives behind the `external-plugins` rollout
 * gate (assistant flag store key `externalPlugins`), so onboarding must not
 * surface or materialize plugins when it's off — otherwise we'd bypass the gate
 * and expose/install marketplace plugins to an unentitled workspace. Waits
 * (bounded) for the flag store to hydrate so a cold load doesn't read the
 * default-off value as a hard "no"; an un-hydrated timeout is treated as off.
 */
async function awaitExternalPluginsEnabled(
  isStale: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + FLAG_HYDRATE_TIMEOUT_MS;
  while (
    !useAssistantFeatureFlagStore.getState().hasHydrated &&
    Date.now() < deadline
  ) {
    await sleep(250);
    if (isStale()) return false;
  }
  return useAssistantFeatureFlagStore.getState().externalPlugins === true;
}

/** Latest assistant reply text from a messages list (text blocks, then legacy flat content). */
function latestAssistantText(messages: GetMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const blocks = m.contentBlocks;
    if (blocks && blocks.length > 0) {
      const text = blocks
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return (m.content ?? "").trim();
  }
  return "";
}

export function useResearchRunner(): UseResearchRunner {
  const [state, setState] = useState<ResearchRunnerState>({
    status: "idle",
    claims: [],
    suggestions: [],
    installedPlugins: [],
  });
  // Monotonic run id: every fresh run claims the next id; in-flight loops bail
  // the moment a newer run supersedes them. Paired with the last subject key so
  // an identical resubmit is a no-op but an edited one restarts.
  const runIdRef = useRef(0);
  const subjectKeyRef = useRef<string | null>(null);
  // Background plugin installs keyed by name, so the suggestion click can await
  // them all before opening the chat (see `awaitPluginInstalls`). Promises stay
  // resolved in the map, so awaiting a settled one is instant.
  const installPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  // Resolves once the `plugins` DECISION is final for the current run — the
  // model's array has closed (installs, if any, enqueued), or there was nothing
  // installable, or the run ended. The suggestion click awaits this BEFORE the
  // installs, so a click that beats the parse still can't open the chat on an
  // empty install map — yet it does NOT wait on the rest of the research turn,
  // so ordinary clicks (plugins disabled / none picked / already installed)
  // aren't frozen until the whole reply settles.
  const pluginsReadyRef = useRef<Promise<void>>(Promise.resolve());
  const queryClient = useQueryClient();

  const start = useCallback(
    ({ awaitAssistantId, subject, conversationTitle }: StartResearchOptions) => {
      const subjectKey = JSON.stringify(subject);
      if (subjectKeyRef.current === subjectKey) return;
      subjectKeyRef.current = subjectKey;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const isStale = () => runIdRef.current !== runId;
      // Fresh run — drop installs tracked for a superseded subject, and arm a new
      // plugins-ready latch the click can await (resolved once the plugin
      // decision is final; the `finally` is the backstop on every exit path).
      let resolvePluginsReady: () => void = () => {};
      pluginsReadyRef.current = new Promise<void>((res) => {
        resolvePluginsReady = res;
      });
      installPromisesRef.current.clear();
      setState({
        status: "running",
        claims: [],
        suggestions: [],
        installedPlugins: [],
      });

      void (async () => {
        let resolvedAssistantId: string | undefined;
        let createdConversationId: string | undefined;
        try {
          const assistantId = await awaitAssistantId();
          resolvedAssistantId = assistantId;
          if (isStale()) return;

          // Advertise the live marketplace catalog to the research turn so it can
          // pick the capabilities that best fit the person (returned as a
          // top-level `plugins` list) for us to install. Only when the external-
          // plugin surface is enabled for this assistant; otherwise run plain
          // research with no plugin injection or install. Best-effort: an empty
          // list just omits the capabilities block.
          const pluginsEnabled = await awaitExternalPluginsEnabled(isStale);
          if (isStale()) return;
          const { capabilities, validNames } = pluginsEnabled
            ? await fetchAvailableCapabilities(assistantId)
            : EMPTY_CAPABILITIES;
          if (isStale()) return;
          // Nothing installable (plugins disabled or empty catalog) — release the
          // click gate now so suggestion clicks never wait on the research turn.
          if (validNames.size === 0) resolvePluginsReady();

          // Tracks every install fired this run (deterministic floor + the model's
          // later picks), keyed by name so the suggestion click can await them and
          // a name is never installed twice.
          const installs = installPromisesRef.current;
          // Deterministic floor: the always-install baseline plus the role's
          // affinity matches, narrowed to the live catalog. Fired here — right
          // after the catalog fetch, before the model has replied — so these
          // materialize while the research turn is still streaming. The model's
          // `plugins` picks (handled in the poll loop) union on top for the long
          // tail of roles this map doesn't enumerate.
          const deterministicPlugins = resolveDeterministicPlugins(
            subject.occupation,
            validNames,
          );
          for (const name of deterministicPlugins) {
            if (!installs.has(name)) {
              installs.set(name, installCapabilityBestEffort(assistantId, name));
            }
          }
          if (deterministicPlugins.length > 0) {
            setState((s) => ({ ...s, installedPlugins: deterministicPlugins }));
          }

          const conversation = await conversationsPost({
            path: { assistant_id: assistantId },
            body: {
              conversationType: "standard",
              ...(conversationTitle ? { title: conversationTitle } : {}),
            },
            throwOnError: false,
          });
          // Capture the created conversation id BEFORE the stale check so a
          // superseded run still archives its throwaway side conversation in the
          // finally block. The finally already guards on truthiness, so an
          // undefined id here is harmless.
          createdConversationId = conversation.data?.id;
          if (isStale()) return;
          const conversationId = conversation.data?.id;
          if (!conversation.response?.ok || !conversationId) {
            setState((s) => ({ ...s, status: "error" }));
            return;
          }

          const body: MessagesPostData["body"] = {
            conversationId,
            content: buildResearchPrompt(subject, capabilities),
            sourceChannel: "vellum",
            interface: "vellum",
            clientMessageId: crypto.randomUUID(),
          };
          // Carry the browser timezone so any time-relative reasoning resolves
          // to the user's local clock. Mirrors `checkin-scheduler.ts`.
          try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (tz) body.clientTimezone = tz;
          } catch {
            // Intl unavailable — daemon falls back to its own cascade.
          }

          const posted = await messagesPost({
            path: { assistant_id: assistantId },
            body,
            throwOnError: false,
          });
          if (isStale()) return;
          if (!posted.response?.ok) {
            setState((s) => ({ ...s, status: "error" }));
            return;
          }

          // Poll the conversation, parsing the (possibly partial) reply each
          // pass so claims/suggestions surface as they land. Settle once the
          // reply text stops changing.
          const deadline = Date.now() + MAX_POLL_MS;
          let lastText = "";
          let stableReads = 0;
          // The model's `plugins` picks fire as soon as its array closes — emitted
          // first in the reply, so this lands early while claims/suggestions are
          // still streaming. These union on top of the deterministic floor already
          // installing (see above); idempotent, so racing the same name is fine.
          while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            if (isStale()) return;
            const listed = await messagesGet({
              path: { assistant_id: assistantId },
              query: { conversationId },
              throwOnError: false,
            });
            if (isStale()) return;
            const messages = listed.data?.messages ?? [];
            const text = latestAssistantText(messages);
            if (text) {
              const { claims, suggestions, plugins, pluginsResolved, complete } =
                parseResearchResultStreaming(text);
              // Narrow the model's picks to the catalog we actually fetched so a
              // hallucinated name never hits the install route; fire each new one.
              const validPlugins = plugins.filter((name) => validNames.has(name));
              for (const name of validPlugins) {
                if (!installs.has(name)) {
                  installs.set(
                    name,
                    installCapabilityBestEffort(assistantId, name),
                  );
                }
              }
              // Once the plugin decision is final (array closed, even if empty),
              // the install set is complete — release the click gate so it waits
              // only on the installs themselves, not the rest of the turn.
              if (pluginsResolved) resolvePluginsReady();
              setState({
                status: "running",
                claims,
                suggestions,
                // Surface the full set actually installing: the deterministic
                // floor plus the model's picks, deduped, baseline first.
                installedPlugins: [
                  ...new Set([...deterministicPlugins, ...validPlugins]),
                ],
              });
              stableReads = text === lastText ? stableReads + 1 : 0;
              lastText = text;
              // Only a complete payload can settle early. A partial JSON object
              // can pause between claim/suggestion objects for long enough to
              // look stable, but it may still be mid-response.
              if (shouldSettleResearchPoll({ complete, stableReads })) break;
            }
          }

          if (isStale()) return;
          setState((s) => ({ ...s, status: "done" }));
        } catch (err) {
          if (isStale()) return;
          captureError(err, { context: "research_onboarding_runner" });
          setState((s) => ({ ...s, status: "error" }));
        } finally {
          // Backstop: release the click gate on every exit path (done, error, or
          // a stale bail-out, or a reply that never emitted a `plugins` array) so
          // `awaitPluginInstalls` can never hang.
          resolvePluginsReady();
          // Archive the throwaway research conversation on every exit path (settled,
          // errored, or superseded by a newer run) once it has been created, so the
          // side channel never lingers in the sidebar on handoff. Best-effort +
          // idempotent; awaiting lets the cache invalidation reflect the archived state.
          if (resolvedAssistantId && createdConversationId) {
            await archiveResearchConversation(
              resolvedAssistantId,
              createdConversationId,
            );
            void invalidateConversationQueries(queryClient, resolvedAssistantId);
          }
        }
      })();
    },
    [queryClient],
  );

  const awaitPluginInstalls = useCallback(async (): Promise<void> => {
    // Wait only for the plugin decision to be final (so a click that beats the
    // parse doesn't await an empty map), then for those installs — never for the
    // rest of the research turn. Resolves instantly when nothing is installable.
    await pluginsReadyRef.current;
    await Promise.all([...installPromisesRef.current.values()]);
  }, []);

  return { ...state, start, awaitPluginInstalls };
}
