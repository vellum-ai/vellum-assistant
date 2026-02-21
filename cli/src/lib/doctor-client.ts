import { spawn } from "child_process";
import { join } from "path";

import { DOCTOR_PORT } from "./constants";
import { readPid, writePid } from "./pid";

export type ProgressPhase = "invoking_prompt" | "calling_tool" | "processing_tool_result";

export interface ProgressEvent {
  phase: ProgressPhase;
  toolName?: string;
}

interface DoctorResult {
  assistantId: string;
  diagnostics: string | null;
  recommendation: string | null;
  error: string | null;
}

export interface ChatLogEntry {
  role: "user" | "assistant" | "error";
  content: string;
}

type DoctorProgressCallback = (event: ProgressEvent) => void;
type DoctorLogCallback = (message: string) => void;

async function isDoctorDaemonAlive(): Promise<boolean> {
  const pid = readPid("doctor");
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${DOCTOR_PORT}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDoctorDaemon(): Promise<void> {
  if (await isDoctorDaemonAlive()) return;

  const daemonPath = join(import.meta.dir, "doctor.ts");
  const child = spawn("bun", ["run", daemonPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid) {
    writePid("doctor", child.pid);
  }

  const maxWait = 3000;
  const interval = 200;
  let elapsed = 0;
  while (elapsed < maxWait) {
    try {
      const res = await fetch(`http://127.0.0.1:${DOCTOR_PORT}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    elapsed += interval;
  }

  throw new Error("Doctor daemon failed to start within 3 seconds");
}

async function streamDoctorResponse(
  response: globalThis.Response,
  onProgress?: DoctorProgressCallback,
  onLog?: DoctorLogCallback,
): Promise<DoctorResult> {
  if (!response.body) {
    throw new Error(
      `No response body from doctor daemon (HTTP ${response.status} ${response.statusText})`,
    );
  }

  let result: DoctorResult | null = null;
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  const receivedEventTypes: string[] = [];

  try {
    for await (const chunk of response.body) {
      chunkCount++;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { type: string } & Record<string, unknown>;
        receivedEventTypes.push(parsed.type);
        if (parsed.type === "progress") {
          onProgress?.(parsed as unknown as ProgressEvent);
        } else if (parsed.type === "log") {
          onLog?.((parsed as unknown as { message: string }).message);
        } else if (parsed.type === "result") {
          result = parsed as unknown as DoctorResult;
        }
      }
    }
  } catch (streamErr) {
    const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
    throw new Error(
      `Doctor daemon stream interrupted after ${chunkCount} chunks ` +
        `(received events: [${receivedEventTypes.join(", ")}]): ${detail}`,
    );
  }

  if (buffer.trim()) {
    const parsed = JSON.parse(buffer) as { type: string } & Record<string, unknown>;
    receivedEventTypes.push(parsed.type);
    if (parsed.type === "result") {
      result = parsed as unknown as DoctorResult;
    }
  }

  if (!result) {
    throw new Error(
      `No result received from doctor daemon. ` +
        `HTTP ${response.status}, ${chunkCount} chunks read, ` +
        `events received: [${receivedEventTypes.join(", ")}], ` +
        `trailing buffer: ${buffer.trim() ? JSON.stringify(buffer.trim().slice(0, 200)) : "(empty)"}`,
    );
  }

  return result;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function callDoctorDaemon(
  assistantId: string,
  project?: string,
  zone?: string,
  userPrompt?: string,
  onProgress?: DoctorProgressCallback,
  sessionId?: string,
  chatContext?: ChatLogEntry[],
  onLog?: DoctorLogCallback,
): Promise<DoctorResult> {
  await ensureDoctorDaemon();

  const daemonPid = readPid("doctor");
  const MAX_RETRIES = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DOCTOR_PORT}/doctor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId, project, zone, userPrompt, sessionId, chatContext }),
      });
      return await streamDoctorResponse(response, onProgress, onLog);
    } catch (err) {
      lastError = err;
      const daemonStillAlive = daemonPid !== null && isProcessAlive(daemonPid);
      const errMsg = err instanceof Error ? err.message : String(err);
      const logMsg =
        `[doctor-client] Attempt ${attempt + 1}/${MAX_RETRIES} failed ` +
        `(daemon pid=${daemonPid ?? "unknown"}, alive=${daemonStillAlive}): ${errMsg}`;
      onLog?.(logMsg);
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw lastError;
}

export { callDoctorDaemon, ensureDoctorDaemon, isDoctorDaemonAlive };
export type { DoctorProgressCallback, DoctorResult };
