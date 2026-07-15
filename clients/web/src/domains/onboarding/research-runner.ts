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
  telemetryOnboardingresearchPost,
} from "@/generated/daemon/sdk.gen";
import { archiveResearchConversation } from "@/domains/onboarding/archive-research-conversation";
import { invalidateConversationQueries } from "@/utils/conversation-cache";
import type {
  MessagesPostData,
  PluginsSearchGetResponses,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { latestAssistantText } from "@/utils/latest-assistant-text";
import { detectClientOs } from "@/runtime/platform-detection";
import {
  buildResearchPrompt,
  type AvailableCapability,
  type ResearchSubject,
} from "@/domains/onboarding/research-prompt";
import { resolveDeterministicPlugins } from "@/domains/onboarding/onboarding-plugin-affinity";
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

export function resolveResearchCompletionStatus({
  sawCompletePayload,
}: {
  sawCompletePayload: boolean;
}): ResearchStatus {
  return sawCompletePayload ? "done" : "error";
}

export function shouldArchiveCompletedResearchConversation({
  sawCompletePayload,
}: {
  sawCompletePayload: boolean;
}): boolean {
  return sawCompletePayload;
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

/**
 * Pull the live marketplace catalog and compact it into the first-party
 * capability list the research prompt advertises. Best-effort: any failure
 * yields an empty list, in which case the prompt simply omits the capabilities
 * block.
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

/**
 * Report a research turn's outcome (claims/suggestions/plugin picks) for
 * analytics. Client-orchestrated: the daemon never detects this turn on its
 * own, so the client reports it once — either as the raw model output the
 * moment the reply parses as a complete JSON payload (`status: "done"`,
 * before the deterministic-floor merge folds in role-based baseline
 * plugins), or as whatever had been parsed so far if the poll ceiling fires
 * first (`status: "error"`). Fire-and-forget: a failure here must never
 * block or surface in the flow, mirroring `archiveResearchConversation`.
 */
async function sendOnboardingResearchTelemetry({
  assistantId,
  conversationId,
  status,
  claims,
  suggestions,
  plugins,
  installedPlugins,
}: {
  assistantId: string;
  conversationId: string;
  status: "done" | "error";
  claims: ResearchFact[];
  suggestions: ResearchSuggestion[];
  plugins: string[];
  installedPlugins: string[];
}): Promise<void> {
  try {
    await telemetryOnboardingresearchPost({
      path: { assistant_id: assistantId },
      body: {
        conversation_id: conversationId,
        status,
        claims,
        suggestions,
        plugins,
        installed_plugins: installedPlugins,
      },
      throwOnError: false,
    });
  } catch (err) {
    captureError(err, { context: "research_onboarding_telemetry" });
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
   * confirm what was set up. Empty when the first-party catalog is unavailable
   * or nothing fit.
   */
  installedPlugins: string[];
  /**
   * Map of plugin install name → one-line description, from the fetched
   * first-party catalog. Lets the UI render each installed plugin with its real
   * name + description (not just the name). Empty when the catalog was
   * unavailable (or, after a refresh-resume, not re-fetched).
   */
  pluginCatalog: Record<string, string>;
}

export interface StartResearchOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  subject: ResearchSubject;
  /** Friendly title for the behind-the-scenes research conversation. */
  conversationTitle?: string;
  /**
   * Resume a research conversation a prior session minted (a refresh mid-search)
   * instead of creating a fresh one. The prior turn keeps generating server-side
   * across the reload, so we re-attach and poll it — re-posting the prompt only
   * if it never landed before the refresh — so the search is never run twice. If
   * the conversation is gone (e.g. it completed and was archived), falls back to
   * a fresh run so the user still gets results.
   */
  resumeConversationId?: string;
  /**
   * Invoked with the conversation id the moment a FRESH research conversation is
   * minted (not on resume), so the caller can persist it and resume this exact
   * thread if the page is refreshed mid-search.
   */
  onConversationCreated?: (conversationId: string) => void;
  /**
   * Whether to ask the model for clickable `suggestions`. Off for the "Let's
   * chat" final step (personality-onboarding flag), which installs the picked
   * plugins and primes a chat instead of surfacing suggestion cards. Defaults to
   * true so the legacy suggestions flow is unchanged.
   */
  includeSuggestions?: boolean;
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
   * the research turn. Resolves instantly when nothing is installable (empty
   * catalog, none picked, or already installed), so ordinary clicks don't hang.
   */
  awaitPluginInstalls: () => Promise<void>;
  /**
   * Adopt research output persisted by a prior session (a page refresh) as the
   * settled state, WITHOUT re-running the turn — so a refresh that resumes past
   * a completed search never fires a second "research me" background turn.
   *
   * The plugin installs are best-effort and fire-and-forget, so a refresh can
   * cancel ones that hadn't settled, leaving capabilities the UI claims were set
   * up not actually installed. So when `awaitAssistantId` is supplied, re-enqueue
   * an install for each named plugin (idempotent — an already-installed plugin
   * 409s and is ignored) and track its promise, so `awaitPluginInstalls` blocks a
   * suggestion click until the capabilities are genuinely present again.
   */
  hydrate: (
    results: ResearchRunnerState,
    awaitAssistantId?: () => Promise<string>,
  ) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function resolveOnboardingPluginInstalls({
  role,
  validNames,
  modelPlugins,
}: {
  role: string;
  validNames: Set<string>;
  modelPlugins: readonly string[];
}): string[] {
  return [
    ...new Set([
      ...resolveDeterministicPlugins(role, validNames),
      ...modelPlugins.filter((name) => validNames.has(name)),
    ]),
  ];
}

export function useResearchRunner(): UseResearchRunner {
  const [state, setState] = useState<ResearchRunnerState>({
    status: "idle",
    claims: [],
    suggestions: [],
    installedPlugins: [],
    pluginCatalog: {},
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
    ({
      awaitAssistantId,
      subject,
      conversationTitle,
      resumeConversationId,
      onConversationCreated,
      includeSuggestions = true,
    }: StartResearchOptions) => {
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
        pluginCatalog: {},
      });

      void (async () => {
        let resolvedAssistantId: string | undefined;
        let createdConversationId: string | undefined;
        let sawCompletePayload = false;
        try {
          const assistantId = await awaitAssistantId();
          resolvedAssistantId = assistantId;
          if (isStale()) return;

          // Advertise the Vellum-owned marketplace capabilities to the research
          // turn so it can pick the ones that best fit the person (returned as a
          // top-level `plugins` list) for us to install. The catalog filter keeps
          // onboarding scoped to first-party plugins; third-party plugin
          // browsing/install surfaces remain independently feature-gated.
          const { capabilities, validNames } =
            await fetchAvailableCapabilities(assistantId);
          if (isStale()) return;
          // Name → description for the fetched catalog, so the UI can show each
          // installed plugin with its real name + description. Carried on every
          // state update below (the poll loop replaces state wholesale).
          const pluginCatalog: Record<string, string> = Object.fromEntries(
            capabilities.map((c) => [c.name, c.description]),
          );
          setState((s) => ({ ...s, pluginCatalog }));
          // Nothing installable (empty/unavailable catalog) — release the click
          // gate so suggestion clicks never wait on the research turn.
          if (validNames.size === 0) resolvePluginsReady();

          // Tracks every install fired this run (deterministic floor + the model's
          // later picks), keyed by name so the suggestion click can await them and
          // a name is never installed twice.
          const installs = installPromisesRef.current;
          // Deterministic floor: the always-install baseline plus any
          // marketing-attributed pick (the plugin the user clicked "Install" on
          // before onboarding — resolved inside `resolveDeterministicPlugins`)
          // plus the role's affinity matches, narrowed to the live catalog.
          // Fired here — right after the catalog fetch, before the model has
          // replied — so these materialize while the research turn is still
          // streaming. The model's `plugins` picks (handled in the poll loop)
          // union on top for the long tail of roles this map doesn't enumerate.
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

          // Post the research prompt onto a conversation. Returns false on a
          // failed POST so the caller can settle "error".
          const postResearchPrompt = async (cid: string): Promise<boolean> => {
            const body: MessagesPostData["body"] = {
              conversationId: cid,
              content: buildResearchPrompt(subject, capabilities, {
                includeSuggestions,
              }),
              sourceChannel: "vellum",
              // `interface` is the transport ("web"); the real OS travels in
              // `clientOs` so the assistant's `client_os` context is correct
              // for this onboarding side conversation too, without affecting
              // transport/host-proxy gating (mirrors `chat/api/messages.ts`).
              interface: "web",
              clientOs: detectClientOs(),
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
            return Boolean(posted.response?.ok);
          };

          // Mint a fresh research conversation + fire the prompt. Used for the
          // initial run and as the resume fallback when the prior conversation
          // is gone.
          const startFreshConversation = async (): Promise<
            string | undefined
          > => {
            const conversation = await conversationsPost({
              path: { assistant_id: assistantId },
              body: {
                conversationType: "standard",
                ...(conversationTitle ? { title: conversationTitle } : {}),
              },
              throwOnError: false,
            });
            // Capture before the stale check so the finally block can archive it
            // once a complete payload settles.
            createdConversationId = conversation.data?.id;
            const id = conversation.data?.id;
            if (!conversation.response?.ok || !id) return undefined;
            // Surface the new id immediately so the caller can persist it and
            // resume this exact thread across a refresh.
            onConversationCreated?.(id);
            return id;
          };

          let conversationId: string | undefined;
          if (resumeConversationId) {
            // Resume the prior session's research conversation rather than
            // running a second search. The turn keeps generating server-side
            // across the reload, so re-attach and poll it; only re-post the
            // prompt if it never landed before the refresh (no user message).
            const existing = await messagesGet({
              path: { assistant_id: assistantId },
              query: { conversationId: resumeConversationId },
              throwOnError: false,
            });
            if (isStale()) return;
            if (existing.response?.ok) {
              conversationId = resumeConversationId;
              createdConversationId = resumeConversationId;
              const turnAlreadyStarted = (existing.data?.messages ?? []).some(
                (m) => m.role === "user",
              );
              if (!turnAlreadyStarted) {
                if (!(await postResearchPrompt(conversationId))) {
                  setState((s) => ({ ...s, status: "error" }));
                  return;
                }
                if (isStale()) return;
              }
            }
            // Not ok → conversation gone (e.g. completed + archived); fall
            // through to a fresh run below.
          }

          if (!conversationId) {
            conversationId = await startFreshConversation();
            if (isStale()) return;
            if (!conversationId) {
              setState((s) => ({ ...s, status: "error" }));
              return;
            }
            if (!(await postResearchPrompt(conversationId))) {
              setState((s) => ({ ...s, status: "error" }));
              return;
            }
            if (isStale()) return;
          }

          // Poll the conversation, parsing the (possibly partial) reply each
          // pass so claims/suggestions surface as they land. Settle once the
          // reply text stops changing.
          const deadline = Date.now() + MAX_POLL_MS;
          let lastText = "";
          let stableReads = 0;
          // Guards the telemetry report to fire exactly once: `complete` can
          // stay true across the `STABLE_READS_TO_SETTLE` re-polls before the
          // loop breaks, and would otherwise re-send on every one of them.
          let telemetrySent = false;
          // Last-known partial result, so a poll-ceiling timeout (the loop
          // exits without ever seeing `complete`) can still report what had
          // been parsed so far instead of the turn silently never being
          // reported at all. `lastInstalledPlugins` seeds from the
          // deterministic floor (already fired above, before any poll tick)
          // rather than `[]`, so a timeout on a turn that never produced any
          // assistant text doesn't undercount installs that already happened.
          let lastClaims: ResearchFact[] = [];
          let lastSuggestions: ResearchSuggestion[] = [];
          let lastPlugins: string[] = [];
          let lastInstalledPlugins: string[] = deterministicPlugins;
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
              // Surface the full set actually installing: the deterministic
              // floor plus the model's picks, deduped, baseline first. Shared
              // by the state update and the telemetry report below so it's
              // only computed once per poll.
              const installedPlugins = resolveOnboardingPluginInstalls({
                role: subject.occupation,
                validNames,
                modelPlugins: validPlugins,
              });
              setState({
                status: "running",
                claims,
                suggestions,
                installedPlugins,
                pluginCatalog,
              });
              lastClaims = claims;
              lastSuggestions = suggestions;
              lastPlugins = plugins;
              lastInstalledPlugins = installedPlugins;
              if (complete) sawCompletePayload = true;
              if (complete && !telemetrySent) {
                telemetrySent = true;
                void sendOnboardingResearchTelemetry({
                  assistantId,
                  conversationId,
                  status: "done",
                  claims,
                  suggestions,
                  plugins,
                  installedPlugins,
                });
              }
              stableReads = text === lastText ? stableReads + 1 : 0;
              lastText = text;
              // Only a complete payload can settle early. A partial JSON object
              // can pause between claim/suggestion objects for long enough to
              // look stable, but it may still be mid-response.
              if (shouldSettleResearchPoll({ complete, stableReads })) {
                break;
              }
            }
          }

          if (isStale()) return;
          // The poll ceiling fired before a complete payload ever landed —
          // the in-loop send above never ran. Report the timeout with
          // whatever had been parsed so far rather than letting the turn go
          // unreported and skewing the event stream toward successful runs.
          if (!telemetrySent) {
            telemetrySent = true;
            void sendOnboardingResearchTelemetry({
              assistantId,
              conversationId,
              status: "error",
              claims: lastClaims,
              suggestions: lastSuggestions,
              plugins: lastPlugins,
              installedPlugins: lastInstalledPlugins,
            });
          }
          setState((s) => ({
            ...s,
            status: resolveResearchCompletionStatus({ sawCompletePayload }),
          }));
        } catch (err) {
          if (isStale()) return;
          captureError(err, { context: "research_onboarding_runner" });
          setState((s) => ({ ...s, status: "error" }));
        } finally {
          // Backstop: release the click gate on every exit path (done, error, or
          // a stale bail-out, or a reply that never emitted a `plugins` array) so
          // `awaitPluginInstalls` can never hang.
          resolvePluginsReady();
          // Archive only after the full research payload is available. If the poll
          // ceiling fired before that, the assistant turn may still be running and
          // the conversation remains available for reconciliation/debugging.
          if (
            shouldArchiveCompletedResearchConversation({
              sawCompletePayload,
            }) &&
            resolvedAssistantId &&
            createdConversationId
          ) {
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

  const hydrate = useCallback(
    (
      results: ResearchRunnerState,
      awaitAssistantId?: () => Promise<string>,
    ) => {
      // Claim a fresh run id so any (improbable) in-flight loop bails, then adopt
      // the restored results as the settled state. We don't set a subject key:
      // the route only re-fires `start` while results are absent, so a re-run
      // can't race this — and an edited subject should still supersede normally.
      runIdRef.current += 1;
      setState(results);

      // Re-enqueue the named installs against the (re-)hatched assistant so a
      // suggestion click awaits real promises rather than an empty map. Idempotent
      // and best-effort: a failed hatch / install never blocks the click.
      if (awaitAssistantId && results.installedPlugins.length > 0) {
        const installs = installPromisesRef.current;
        installs.clear();
        for (const name of results.installedPlugins) {
          installs.set(
            name,
            (async () => {
              try {
                const assistantId = await awaitAssistantId();
                await installCapabilityBestEffort(assistantId, name);
              } catch {
                // Hatch never readied / install failed — don't block the click.
              }
            })(),
          );
        }
      }
    },
    [],
  );

  return { ...state, start, awaitPluginInstalls, hydrate };
}
