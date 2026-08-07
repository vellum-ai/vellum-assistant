/**
 * Pinned-model liveness check (JARVIS-1375).
 *
 * Every model id this codebase pins is a bet that a provider keeps serving it.
 * Three of those bets broke inside two days, and none was visible from the
 * code: `gemini-live-2.5-flash-preview` was retired (1008), every current Live
 * model turned out to reject `responseModalities: [TEXT]` (1007), and two
 * `-preview` ids 404ed on Vertex while returning 200 from the Gemini API. This
 * script probes each pin so the next one surfaces here instead of in a support
 * email.
 *
 * THE THING THAT MAKES THIS NON-TRIVIAL: a pin must be probed on the transport
 * that will actually carry it, and availability genuinely differs between them.
 *
 *   id                            Gemini API   Vertex
 *   gemini-3.1-flash-lite-preview 200          404
 *   gemini-embedding-2-preview    200          404
 *   gemini-embedding-001          200          404
 *   gemini-embedding-2            200          200
 *
 * Managed Gemini is rewritten to Vertex by the platform proxy (every
 * `v1beta/models/{model}:{method}` path, `:embedContent` included), so a check
 * against `generativelanguage` would have passed while managed traffic was
 * failing. BYOK Gemini really does go to `generativelanguage`, so both
 * transports have to be probed, against the same id, independently.
 *
 * Existence is also not sufficient on its own. The Live check sends the real
 * session config rather than merely asking whether the model exists, because
 * the 1007 failure was a served model rejecting our request shape.
 *
 * Credentials (each optional; a missing one SKIPS its checks rather than
 * failing them, so a partial run is still useful):
 *   ADC / gcloud      Vertex        `gcloud auth print-access-token`
 *   GEMINI_API_KEY    Gemini API + Live
 *   OPENAI_API_KEY    OpenAI
 *   ANTHROPIC_API_KEY Anthropic
 *
 * Usage:
 *   bun run scripts/check-model-pins.ts [--project <gcp-project>] [--json]
 *
 * Exits non-zero if any probed pin fails, so this can be wired to cron or CI
 * once a service account is chosen for the runner.
 */

import { GoogleGenAI, Modality } from "@google/genai";

import { CODE_DEFAULT_PROFILE_ENTRIES } from "../src/config/default-profile-catalog.js";
import { MemoryEmbeddingsConfigSchema } from "../src/config/schemas/memory-storage.js";
import { PROVIDER_CATALOG } from "../src/providers/model-catalog.js";
import { resolveModelIntent } from "../src/providers/model-intents.js";
import { DEFAULT_MODEL as GEMINI_BATCH_STT_MODEL } from "../src/providers/speech-to-text/google-gemini.js";
import { DEFAULT_MODEL as GEMINI_LIVE_STT_MODEL } from "../src/providers/speech-to-text/google-gemini-live-stream.js";
import type { ModelIntent } from "../src/providers/types.js";
import { getManagedUpstream } from "../src/providers/vellum-model-routing.js";

const VERTEX_LOCATION = "global";
const DEFAULT_VERTEX_PROJECT = "vellum-nonprod";
const LIVE_CONNECT_TIMEOUT_MS = 15_000;

/** Providers this script knows how to reach. Others are reported as skipped. */
const PROBEABLE = new Set(["gemini", "openai", "anthropic"]);

type Transport =
  | "vertex"
  | "gemini-api"
  | "openai"
  | "anthropic"
  | "live"
  /** Provider this script has no probe for; reported as skipped. */
  | "unprobed";

interface Pin {
  /** Where the id is declared, shown in the report so a failure is findable. */
  source: string;
  provider: string;
  model: string;
  transport: Transport;
}

type Status = "ok" | "fail" | "skip";

interface Result extends Pin {
  status: Status;
  detail: string;
}

// ---------------------------------------------------------------------------
// Pin collection
// ---------------------------------------------------------------------------

/**
 * Every model id the codebase pins, paired with the transport that will carry
 * it. Read from the live declarations rather than a hand-kept list, so a pin
 * added elsewhere is covered here without a second edit.
 */
function collectPins(): Pin[] {
  const pins: Pin[] = [];

  // Managed default profiles. `provider: "vellum"` is the provider-agnostic
  // sentinel; the real upstream comes from the model id, and gemini among
  // those routes to Vertex.
  for (const [key, entry] of Object.entries(CODE_DEFAULT_PROFILE_ENTRIES)) {
    const model = entry.model as string | undefined;
    if (!model) {
      continue;
    }
    const upstream = getManagedUpstream(model) ?? (entry.provider as string);
    pins.push({
      source: `default-profile-catalog:${key}`,
      provider: upstream,
      model,
      transport: upstream === "gemini" ? "vertex" : transportFor(upstream),
    });
  }

  // BYOK intent table: every provider column, every intent. These run on the
  // user's own key, so gemini here is the Gemini API rather than Vertex.
  const intents: ModelIntent[] = [
    "balanced",
    "latency-optimized",
    "quality-optimized",
    "vision-optimized",
  ];
  for (const provider of PROVIDER_CATALOG) {
    for (const intent of intents) {
      const model = resolveModelIntent(provider.id, intent);
      if (!model) {
        continue;
      }
      pins.push({
        source: `model-intents:${provider.id}.${intent}`,
        provider: provider.id,
        model,
        transport:
          provider.id === "gemini" ? "gemini-api" : transportFor(provider.id),
      });
    }
  }

  // Speech-to-text. The Live pin is the one that needs a real session rather
  // than an existence check.
  pins.push({
    source: "speech-to-text:google-gemini-live-stream",
    provider: "gemini",
    model: GEMINI_LIVE_STT_MODEL,
    transport: "live",
  });
  pins.push({
    source: "speech-to-text:google-gemini (batch)",
    provider: "gemini",
    model: GEMINI_BATCH_STT_MODEL,
    transport: "gemini-api",
  });

  // Embedding default. Platform assistants embed through the managed proxy,
  // so this is a Vertex `:embedContent` pin.
  pins.push({
    source: "memory.embeddings.geminiModel",
    provider: "gemini",
    model: MemoryEmbeddingsConfigSchema.parse({}).geminiModel,
    transport: "vertex",
  });

  return dedupe(pins);
}

function transportFor(provider: string): Transport {
  if (provider === "openai") {
    return "openai";
  }
  if (provider === "anthropic") {
    return "anthropic";
  }
  if (provider === "gemini") {
    return "gemini-api";
  }
  // Naming the transport "unprobed" rather than defaulting to a real one keeps
  // the report honest: a fireworks pin listed under `gemini-api` would read as
  // though it had been checked against Google.
  return "unprobed";
}

/** Same id on the same transport is one probe, with sources merged. */
function dedupe(pins: Pin[]): Pin[] {
  const byKey = new Map<string, Pin>();
  for (const pin of pins) {
    const key = `${pin.transport}::${pin.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.source = `${existing.source}, ${pin.source}`;
    } else {
      byKey.set(key, { ...pin });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function adcToken(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gcloud", "auth", "print-access-token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/** `embedContent` for embedding models, `generateContent` for the rest. */
function vertexMethod(model: string): string {
  return model.includes("embedding") ? "embedContent" : "generateContent";
}

async function probeVertex(
  pin: Pin,
  token: string,
  project: string,
): Promise<Result> {
  const method = vertexMethod(pin.model);
  const url =
    `https://aiplatform.googleapis.com/v1/projects/${project}/locations/` +
    `${VERTEX_LOCATION}/publishers/google/models/${pin.model}:${method}`;
  // Vertex takes the model from the path; a `model` field in the body is
  // rejected as a duplicate oneof.
  const body =
    method === "embedContent"
      ? { content: { parts: [{ text: "ping" }] } }
      : { contents: [{ role: "user", parts: [{ text: "ping" }] }] };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    return { ...pin, status: "ok", detail: `vertex ${method} 200` };
  }
  return {
    ...pin,
    status: "fail",
    detail: `vertex ${method} ${res.status}: ${(await res.text()).slice(0, 90)}`,
  };
}

async function probeGeminiApi(pin: Pin, apiKey: string): Promise<Result> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${pin.model}?key=${apiKey}`,
  );
  return res.ok
    ? { ...pin, status: "ok", detail: "gemini-api 200" }
    : {
        ...pin,
        status: "fail",
        detail: `gemini-api ${res.status}: ${(await res.text()).slice(0, 90)}`,
      };
}

/**
 * Open a real Live session with the transcriber's own config. An existence
 * check would not catch a served model that rejects the request shape, which
 * is how the 1007 modality break slipped through.
 */
async function probeLive(pin: Pin, apiKey: string): Promise<Result> {
  const ai = new GoogleGenAI({ apiKey });
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(
      () => resolve("timeout waiting for setup"),
      LIVE_CONNECT_TIMEOUT_MS,
    );
    const settle = (v: string): void => {
      clearTimeout(timer);
      resolve(v);
    };
    ai.live
      .connect({
        model: pin.model,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
        },
        callbacks: {
          // `onopen` fires before setup is validated, so a rejection arrives
          // afterwards as a close. Only setupComplete proves the session is
          // usable.
          onopen: () => {},
          onmessage: (m: unknown) => {
            if (JSON.stringify(m).includes("setupComplete")) {
              settle("ok");
            }
          },
          onerror: (e: unknown) =>
            settle(`error ${String((e as Error)?.message ?? e).slice(0, 90)}`),
          onclose: (e: unknown) => {
            const c = e as { code?: number; reason?: string };
            settle(
              `closed ${c?.code}: ${String(c?.reason ?? "").slice(0, 90)}`,
            );
          },
        },
      })
      .catch((e: unknown) =>
        settle(`throw ${String((e as Error)?.message ?? e).slice(0, 90)}`),
      );
  });
  return outcome === "ok"
    ? { ...pin, status: "ok", detail: "live setupComplete" }
    : { ...pin, status: "fail", detail: `live ${outcome}` };
}

async function probeOpenAI(pin: Pin, apiKey: string): Promise<Result> {
  const res = await fetch(`https://api.openai.com/v1/models/${pin.model}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return res.ok
    ? { ...pin, status: "ok", detail: "openai 200" }
    : { ...pin, status: "fail", detail: `openai ${res.status}` };
}

async function probeAnthropic(pin: Pin, apiKey: string): Promise<Result> {
  const res = await fetch(`https://api.anthropic.com/v1/models/${pin.model}`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  return res.ok
    ? { ...pin, status: "ok", detail: "anthropic 200" }
    : { ...pin, status: "fail", detail: `anthropic ${res.status}` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argValue = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const project = argValue("--project") ?? DEFAULT_VERTEX_PROJECT;
  const asJson = argv.includes("--json");

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const token = await adcToken();

  const pins = collectPins();
  const results: Result[] = [];

  for (const pin of pins) {
    if (!PROBEABLE.has(pin.provider)) {
      results.push({
        ...pin,
        status: "skip",
        detail: `no probe for provider "${pin.provider}"`,
      });
      continue;
    }
    try {
      if (pin.transport === "vertex") {
        results.push(
          token
            ? await probeVertex(pin, token, project)
            : { ...pin, status: "skip", detail: "no ADC token (gcloud login)" },
        );
      } else if (pin.transport === "gemini-api") {
        results.push(
          geminiKey
            ? await probeGeminiApi(pin, geminiKey)
            : { ...pin, status: "skip", detail: "GEMINI_API_KEY unset" },
        );
      } else if (pin.transport === "live") {
        results.push(
          geminiKey
            ? await probeLive(pin, geminiKey)
            : { ...pin, status: "skip", detail: "GEMINI_API_KEY unset" },
        );
      } else if (pin.transport === "openai") {
        results.push(
          openaiKey
            ? await probeOpenAI(pin, openaiKey)
            : { ...pin, status: "skip", detail: "OPENAI_API_KEY unset" },
        );
      } else {
        results.push(
          anthropicKey
            ? await probeAnthropic(pin, anthropicKey)
            : { ...pin, status: "skip", detail: "ANTHROPIC_API_KEY unset" },
        );
      }
    } catch (error) {
      results.push({
        ...pin,
        status: "fail",
        detail: `probe threw: ${String(error).slice(0, 90)}`,
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`Vertex project: ${project}\n`);
    for (const r of results) {
      const mark =
        r.status === "ok" ? "OK  " : r.status === "fail" ? "FAIL" : "skip";
      console.log(
        `${mark}  ${r.model.padEnd(38)} ${r.transport.padEnd(11)} ${r.detail}`,
      );
      console.log(`      ${r.source}`);
    }
  }

  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  console.log(
    `\n${results.length - failed.length - skipped.length} ok, ` +
      `${failed.length} failed, ${skipped.length} skipped`,
  );
  if (failed.length > 0) {
    console.log("\nFailed pins:");
    for (const f of failed) {
      console.log(`  ${f.model} (${f.source}) -> ${f.detail}`);
    }
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
