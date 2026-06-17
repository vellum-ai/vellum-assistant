import JSZip from "jszip";

import type { LlmLogPayload } from "@/domains/chat/inspector/inspector-payload-api";
import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import type { LlmContextResponse } from "@vellumai/assistant-api";

export interface InspectorExportFile {
  path: string;
  contents: string;
}

/**
 * Fetches the normalized request/response sections for one log.
 * Resolves `null` when the daemon has no per-log context endpoint
 * (the list entries then carry their sections inline). Other failures
 * should reject so the export surfaces an error instead of silently
 * producing an incomplete archive.
 */
export type LlmCallSectionsFetcher = (
  logId: string,
) => Promise<Pick<
  LLMRequestLogEntry,
  "requestSections" | "responseSections"
> | null>;

interface ActualUserMessageExport {
  callId: string;
  callIndex: number;
  sectionIndex: number;
  label: string | null;
  role: string | null;
  text: string | null;
  data?: unknown;
}

interface BuildInspectorExportFilesOptions {
  exportedAt?: string;
}

export function buildInspectorExportFilename(scopeId: string): string {
  return `llm-inspector-${sanitizePathSegment(scopeId)}.zip`;
}

export function buildInspectorExportFiles(
  context: LlmContextResponse,
  payloads: LlmLogPayload[],
  options: BuildInspectorExportFilesOptions = {},
): InspectorExportFile[] {
  const payloadsByLogId = new Map(payloads.map((payload) => [payload.id, payload]));
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const calls = context.logs.map((log, index) => callManifest(log, index));
  const files: InspectorExportFile[] = [
    {
      path: "README.md",
      contents: buildReadme(),
    },
    {
      path: "manifest.json",
      contents: prettyJson({
        exportedAt,
        conversationId: context.conversationId ?? null,
        messageId: context.messageId ?? null,
        conversationKind: context.conversationKind,
        conversationTotalEstimatedCostUsd:
          context.conversationTotalEstimatedCostUsd ?? null,
        callCount: context.logs.length,
        calls,
      }),
    },
    {
      path: "conversation/actual-user-messages.json",
      contents: prettyJson({
        conversationId: context.conversationId ?? null,
        messageId: context.messageId ?? null,
        description:
          "User-authored message sections extracted from the normalized request context. These are intentionally separate from provider request payloads.",
        messages: extractActualUserMessages(context.logs),
      }),
    },
    {
      path: "conversation/llm-calls.json",
      contents: prettyJson(calls),
    },
    {
      path: "memory/memory-recall.json",
      contents: prettyJson(context.memoryRecall ?? null),
    },
    {
      path: "memory/memory-v2-activation.json",
      contents: prettyJson(context.memoryV2Activation ?? null),
    },
  ];

  context.logs.forEach((log, index) => {
    const dirName = buildCallDirectoryName(log, index);
    const payload = payloadsByLogId.get(log.id);

    files.push(
      {
        path: `normalized-context/calls/${dirName}/summary.json`,
        contents: prettyJson(log.summary ?? null),
      },
      {
        path: `normalized-context/calls/${dirName}/request-sections.json`,
        contents: prettyJson(log.requestSections ?? []),
      },
      {
        path: `normalized-context/calls/${dirName}/response-sections.json`,
        contents: prettyJson(log.responseSections ?? []),
      },
      {
        path: `provider-payloads/calls/${dirName}/request.json`,
        contents: prettyJson(payload?.requestPayload ?? null),
      },
      {
        path: `provider-payloads/calls/${dirName}/response.json`,
        contents: prettyJson(payload?.responsePayload ?? null),
      },
    );
  });

  return files;
}

export async function buildInspectorExportZipBlob(
  context: LlmContextResponse,
  payloads: LlmLogPayload[],
  fetchCallSections?: LlmCallSectionsFetcher,
): Promise<Blob> {
  const hydrated = {
    ...context,
    logs: await hydrateLogSections(context.logs, fetchCallSections),
  };
  const zip = new JSZip();
  for (const file of buildInspectorExportFiles(hydrated, payloads)) {
    zip.file(file.path, file.contents);
  }
  return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
}

/**
 * Lists fetched with `view=summary` omit per-log sections, so the
 * export hydrates each call from the per-log context endpoint. Logs
 * that already carry sections inline (full-view lists from older
 * daemons) are kept as-is.
 */
async function hydrateLogSections(
  logs: LLMRequestLogEntry[],
  fetchCallSections: LlmCallSectionsFetcher | undefined,
): Promise<LLMRequestLogEntry[]> {
  if (!fetchCallSections) return logs;
  return Promise.all(
    logs.map(async (log): Promise<LLMRequestLogEntry> => {
      if (log.requestSections || log.responseSections) return log;
      const detail = await fetchCallSections(log.id);
      if (!detail) return log;
      return {
        ...log,
        requestSections: detail.requestSections,
        responseSections: detail.responseSections,
      };
    }),
  );
}

function extractActualUserMessages(
  logs: LLMRequestLogEntry[],
): ActualUserMessageExport[] {
  const messages: ActualUserMessageExport[] = [];
  logs.forEach((log, callIndex) => {
    for (const [sectionIndex, section] of (
      log.requestSections ?? []
    ).entries()) {
      if (!isUserMessageSection(section)) continue;
      messages.push({
        callId: log.id,
        callIndex,
        sectionIndex,
        label: section.label ?? null,
        role: section.role ?? null,
        text: section.text ?? null,
        ...(section.data === undefined ? {} : { data: section.data }),
      });
    }
  });
  return messages;
}

function isUserMessageSection(section: LLMContextSection): boolean {
  return section.kind === "message" && section.role === "user";
}

function callManifest(log: LLMRequestLogEntry, index: number) {
  return {
    index,
    id: log.id,
    directory: buildCallDirectoryName(log, index),
    createdAt: log.createdAt,
    provider: log.provider ?? log.summary?.provider ?? null,
    model: log.summary?.model ?? null,
    status: log.summary?.status ?? null,
    stopReason: log.summary?.stopReason ?? null,
    estimatedCostUsd: log.summary?.estimatedCostUsd ?? null,
  };
}

function buildCallDirectoryName(log: LLMRequestLogEntry, index: number): string {
  return `${String(index + 1).padStart(3, "0")}-${sanitizePathSegment(log.id)}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "unknown";
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildReadme(): string {
  return `# LLM Inspector Export\n\nThis archive separates the inspector data into human/debug context and provider raw payloads.\n\n## Folders\n\n- \`conversation/actual-user-messages.json\` — user-authored message sections extracted from the normalized request context. This is the human conversation layer.\n- \`normalized-context/calls/<call>/\` — provider-normalized request/response sections plus summary metadata, matching the Prompt / Response / Overview tabs.\n- \`provider-payloads/calls/<call>/\` — raw request and response JSON sent to and received from the LLM provider.\n- \`memory/\` — memory recall and memory-v2 activation snapshots shown in the Memory tab.\n- \`manifest.json\` — export metadata and call directory index.\n\nUse \`conversation/actual-user-messages.json\` when you need to inspect what the user actually said. Use \`provider-payloads/\` when you need to debug the exact provider API envelope.\n`;
}
