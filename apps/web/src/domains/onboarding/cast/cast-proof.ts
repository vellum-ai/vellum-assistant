/**
 * Beat 6 (Proof) data layer.
 *
 * Generates two artifacts from the user's picks:
 *  - RECEIPT  — observation → inference → one-tap offer (the piece the user
 *    reads carefully).
 *  - ARTIFACT — a small proactive thing the dude "made" (title + description).
 *
 * The model is left to the daemon's configured provider/profile — we do not
 * send a `model` override, so this works on non-Anthropic providers too (an
 * override would silently fall back to templates on those).
 *
 * Both go through the daemon's `POST /v1/assistants/{id}/inference/send`
 * endpoint, which runs server-side with the provider key held in the daemon's
 * credential vault — no key is ever exposed to the browser. Since `/assistant/
 * cast` is a public, unauthenticated prototype route there may be no active
 * assistant / session, so every call falls back to local templated generation
 * if the live call is unavailable or fails. The prototype always renders.
 *
 * Ported from the prototype's `@/cast/cast-proof`. Imports rewritten to base:
 * `JOBS`/`RATHERS`/`JobKey`/`RatherKey` come from `cast-content`, and
 * `StyleProfile` from `cast-templates` (the prototype's `cast-hooks` module was
 * not lifted — `cast-templates` is base's home for that type). The daemon SDK
 * and `listAssistants` are shared infra, unchanged.
 */

import { listAssistants } from "@/assistant/api";
import { JOBS, RATHERS, type JobKey, type RatherKey } from "@/domains/onboarding/cast/cast-content";
import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import { inferenceSendPost } from "@/generated/daemon/sdk.gen";

export interface Picks {
  jobs: JobKey[];
  rathers: RatherKey[];
  style: StyleProfile;
}

/**
 * Resolve an assistant id for the live model calls. `/assistant/cast` is a
 * public route with no ActiveAssistantGate, so the selection store is usually
 * empty here — fall back to listing assistants (works when the browser has a
 * session). Returns null when unauthenticated, which routes every generation
 * to its local fallback. Resolved once and memoized.
 */
let resolvedAssistantId: string | null | undefined;
export async function resolveAssistantId(fromStore: string | null): Promise<string | null> {
  if (fromStore) return fromStore;
  if (resolvedAssistantId !== undefined) return resolvedAssistantId;
  try {
    const result = await listAssistants();
    resolvedAssistantId = result.ok && result.data.length ? result.data[0].id : null;
  } catch {
    resolvedAssistantId = null;
  }
  return resolvedAssistantId;
}

export interface Receipt {
  observation: string;
  inference: string;
  offer: string;
  verb: string; // primary-button label, e.g. "Set it up"
}

export interface Artifact {
  title: string;
  description: string;
}

function labelsFor<T extends string>(
  keys: T[],
  table: { key: T; label: string }[],
): string {
  const labels = keys.map((k) => table.find((t) => t.key === k)?.label ?? k);
  if (labels.length === 0) return "exploring";
  if (labels.length === 1) return labels[0].toLowerCase();
  return (
    labels.slice(0, -1).map((l) => l.toLowerCase()).join(", ") +
    " and " +
    labels[labels.length - 1].toLowerCase()
  );
}

function styleWords(style: StyleProfile): string {
  const map: Record<string, string> = {
    send_it: "act without waiting for approval",
    show_me: "check with them before acting",
    point: "keep it short and to the point",
    walk: "walk them through it",
    one: "do one thing really well",
    few: "knock out a few quick wins",
  };
  return [style.autonomy, style.tone, style.shape]
    .filter(Boolean)
    .map((v) => map[v as string] ?? v)
    .join("; ");
}

/** Pull the first JSON object out of a model response, tolerating prose/fences. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Live model call with a hard timeout — the prototype's public route may have
 * a stale/unreachable daemon, so we never let a hung request block the UI. On
 * timeout or any error we return null and the caller uses its local fallback. */
async function callModel(
  assistantId: string,
  systemPrompt: string,
  message: string,
  { maxTokens = 400, timeoutMs = 6000 }: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const live = (async () => {
    try {
      const { data } = await inferenceSendPost({
        path: { assistant_id: assistantId },
        // No `model` override (see file header) — the daemon's configured
        // provider/profile picks it.
        body: { message, systemPrompt, maxTokens },
        throwOnError: false,
      });
      return data?.response ?? null;
    } catch {
      return null;
    }
  })();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([live, timeout]);
}

/* ---------------- Receipt ---------------- */

export async function generateReceipt(
  picks: Picks,
  assistantId: string | null,
): Promise<Receipt> {
  const job = labelsFor(picks.jobs, JOBS);
  const rather = labelsFor(picks.rathers, RATHERS);
  const style = styleWords(picks.style);

  if (assistantId) {
    const raw = await callModel(
      assistantId,
      "You write tight, perceptive onboarding copy. No greeting, no fluff, no emoji. " +
        'Return ONLY a JSON object: {"observation": string, "inference": string, "offer": string, "verb": string}. ' +
        "observation = one specific thing about them; inference = one non-obvious thing you infer; " +
        "offer = one concrete one-tap thing you can do for them; verb = a 1-2 word button label for the offer.",
      `The user's job is ${job}. They would rather be ${rather}. They prefer ${style}. ` +
        "Write the observation, inference, offer, and verb.",
    );
    const j = raw ? extractJson(raw) : null;
    if (
      j &&
      typeof j.observation === "string" &&
      typeof j.inference === "string" &&
      typeof j.offer === "string"
    ) {
      return {
        observation: j.observation,
        inference: j.inference,
        offer: j.offer,
        verb: typeof j.verb === "string" && j.verb.trim() ? j.verb.trim() : "Set it up",
      };
    }
  }

  return localReceipt(picks);
}

function localReceipt(picks: Picks): Receipt {
  const job = labelsFor(picks.jobs, JOBS);
  const rather = labelsFor(picks.rathers, RATHERS);
  const sendIt = picks.style.autonomy === "send_it";
  const walk = picks.style.tone === "walk";
  return {
    observation: `You're spending your days ${job}.`,
    inference: `But you'd rather be ${rather} — which usually means the busywork is eating the part you actually like.`,
    offer: `I can take the ${job} grind off your plate${sendIt ? " and just handle it" : walk ? " and keep you in the loop" : ""}, starting with the most repetitive piece.`,
    verb: sendIt ? "Set it up" : "Show me",
  };
}

/* ---------------- Artifact ---------------- */

export async function generateArtifact(
  picks: Picks,
  assistantId: string | null,
): Promise<Artifact> {
  const job = labelsFor(picks.jobs, JOBS);
  const rather = labelsFor(picks.rathers, RATHERS);

  if (assistantId) {
    const raw = await callModel(
      assistantId,
      "You are an assistant who quietly made the user a small useful or delightful artifact while they were " +
        "being onboarded. No greeting, no fluff. " +
        'Return ONLY a JSON object: {"title": string, "description": string}. ' +
        "title = max 6 words; description = one sentence. " +
        'Examples: {"title":"Three weekend trails near you","description":"..."}, ' +
        '{"title":"Five investor letters worth stealing from","description":"..."}.',
      `Tie it to their job (${job}) and what they'd rather be doing (${rather}).`,
    );
    const j = raw ? extractJson(raw) : null;
    if (j && typeof j.title === "string" && typeof j.description === "string") {
      return { title: j.title, description: j.description };
    }
  }

  return localArtifact(picks);
}

/**
 * Generate N artifacts. The "few quick wins" Proof shape asks for 2-3 small
 * cards; "one thing, well" asks for a single focused one. Each is generated
 * independently (varied by index) so the stack reads as distinct wins.
 */
export async function generateArtifacts(
  picks: Picks,
  count: number,
  assistantId: string | null,
): Promise<Artifact[]> {
  if (count <= 1) return [await generateArtifact(picks, assistantId)];
  const job = labelsFor(picks.jobs, JOBS);
  const rather = labelsFor(picks.rathers, RATHERS);
  const tasks = Array.from({ length: count }, async (_, i) => {
    if (assistantId) {
      const raw = await callModel(
        assistantId,
        "You are an assistant who quietly made the user a few small useful or delightful artifacts " +
          "while they were being onboarded. No greeting, no fluff. " +
          'Return ONLY a JSON object: {"title": string, "description": string}. ' +
          "title = max 6 words; description = one sentence.",
        `This is quick win #${i + 1} of ${count}, distinct from the others. ` +
          `Tie it to their job (${job}) and what they'd rather be doing (${rather}).`,
      );
      const j = raw ? extractJson(raw) : null;
      if (j && typeof j.title === "string" && typeof j.description === "string") {
        return { title: j.title, description: j.description };
      }
    }
    return localArtifact(picks, i);
  });
  return Promise.all(tasks);
}

function localArtifact(picks: Picks, variant = 0): Artifact {
  const rather = labelsFor(picks.rathers, RATHERS);
  const job = labelsFor(picks.jobs, JOBS);
  const variants: Artifact[] = [
    {
      title: `A head start on ${rather}`,
      description: `A few things I lined up to make ${rather} easier to get to — between the ${job}.`,
    },
    {
      title: `${job} on autopilot`,
      description: `The most repetitive part of ${job}, drafted and ready for a glance.`,
    },
    {
      title: `15 minutes back`,
      description: `One recurring chore I can take off your plate this week.`,
    },
  ];
  return variants[variant % variants.length];
}

/* ---------------- Full artifact body (Open overlay) ---------------- */

export async function generateFullArtifact(
  picks: Picks,
  artifact: Artifact,
  assistantId: string | null,
): Promise<string> {
  const job = labelsFor(picks.jobs, JOBS);
  const rather = labelsFor(picks.rathers, RATHERS);
  const style = styleWords(picks.style);

  if (assistantId) {
    const raw = await callModel(
      assistantId,
      "You write short, genuinely useful or delightful pieces. No preamble, no " +
        '"here is your...". Start directly with the content. Use light markdown ' +
        "(a heading, a short list, a line or two of prose). 200-400 words.",
      `You quietly made this for a user during onboarding. Their job is ${job}, ` +
        `they would rather be ${rather}, and they prefer ${style}. ` +
        `The artifact is titled "${artifact.title}" — "${artifact.description}". ` +
        "Write the full artifact.",
      { maxTokens: 900, timeoutMs: 20000 },
    );
    if (raw && raw.trim()) return raw.trim();
  }

  return localFullArtifact(picks, artifact);
}

function localFullArtifact(picks: Picks, artifact: Artifact): string {
  const rather = labelsFor(picks.rathers, RATHERS);
  const job = labelsFor(picks.jobs, JOBS);
  return [
    `## ${artifact.title}`,
    "",
    `You're deep in ${job} — so here's a small running start on **${rather}**, ready whenever you are.`,
    "",
    "- **Pick a window.** Block 90 minutes this week and treat it like a meeting that can't move.",
    "- **Lower the bar to start.** One small step counts; momentum does the rest.",
    "- **Make it visible.** Put it on the calendar where the busywork can't quietly crowd it out.",
    "",
    `I'll keep an eye on the ${job} side so this stays the part you look forward to. ` +
      "Tap Save and I'll keep it handy.",
  ].join("\n");
}
