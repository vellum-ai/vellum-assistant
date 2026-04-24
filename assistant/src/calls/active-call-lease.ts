import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { isTerminalState } from "./call-state-machine.js";
import type { CallSession } from "./types.js";

const log = getLogger("active-call-lease");

const ACTIVE_CALL_LEASES_VERSION = 1 as const;
const ACTIVE_CALL_LEASES_FILE = "active-call-leases.json";

interface ActiveCallLeaseFile {
  version: typeof ACTIVE_CALL_LEASES_VERSION;
  leases: ActiveCallLease[];
}

export interface ActiveCallLease {
  callSessionId: string;
  providerCallSid: string | null;
  updatedAt: number;
}

function getStorePath(): string {
  return join(getWorkspaceDir(), ACTIVE_CALL_LEASES_FILE);
}

function loadLeaseFile(): ActiveCallLeaseFile {
  const path = getStorePath();
  if (!existsSync(path)) {
    return {
      version: ACTIVE_CALL_LEASES_VERSION,
      leases: [],
    };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ActiveCallLeaseFile>;
    if (
      parsed.version !== ACTIVE_CALL_LEASES_VERSION ||
      !Array.isArray(parsed.leases)
    ) {
      log.warn(
        { path },
        "Invalid active call lease file format; starting fresh",
      );
      return {
        version: ACTIVE_CALL_LEASES_VERSION,
        leases: [],
      };
    }

    return {
      version: ACTIVE_CALL_LEASES_VERSION,
      leases: parsed.leases
        .filter(
          (lease): lease is ActiveCallLease =>
            typeof lease?.callSessionId === "string" &&
            (typeof lease.providerCallSid === "string" ||
              lease.providerCallSid == null) &&
            typeof lease.updatedAt === "number",
        )
        .sort((a, b) => a.updatedAt - b.updatedAt),
    };
  } catch (err) {
    log.error({ err, path }, "Failed to load active call lease file");
    return {
      version: ACTIVE_CALL_LEASES_VERSION,
      leases: [],
    };
  }
}

function saveLeaseFile(leases: ActiveCallLease[]): void {
  const path = getStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const payload: ActiveCallLeaseFile = {
    version: ACTIVE_CALL_LEASES_VERSION,
    leases: [...leases].sort((a, b) => a.updatedAt - b.updatedAt),
  };
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort on platforms that ignore POSIX modes.
  }
}

export function clearActiveCallLeases(): void {
  const path = getStorePath();
  if (!existsSync(path)) {
    return;
  }
  try {
    unlinkSync(path);
  } catch (err) {
    log.warn({ err, path }, "Failed to clear active call lease file");
  }
}

export function listActiveCallLeases(): ActiveCallLease[] {
  return loadLeaseFile().leases;
}

export function getActiveCallLease(
  callSessionId: string,
): ActiveCallLease | null {
  return (
    listActiveCallLeases().find(
      (lease) => lease.callSessionId === callSessionId,
    ) ?? null
  );
}

export function upsertActiveCallLease(params: {
  callSessionId: string;
  providerCallSid?: string | null;
  updatedAt?: number;
}): ActiveCallLease {
  const { callSessionId } = params;
  const current = loadLeaseFile().leases;
  const currentById = new Map(
    current.map((lease) => [lease.callSessionId, lease] as const),
  );
  const existing = currentById.get(callSessionId);
  const nextLease: ActiveCallLease = {
    callSessionId,
    providerCallSid:
      params.providerCallSid ?? existing?.providerCallSid ?? null,
    updatedAt: params.updatedAt ?? Date.now(),
  };
  currentById.set(callSessionId, nextLease);
  saveLeaseFile(Array.from(currentById.values()));
  return nextLease;
}

function removeActiveCallLease(callSessionId: string): boolean {
  const current = loadLeaseFile().leases;
  const next = current.filter((lease) => lease.callSessionId !== callSessionId);
  if (next.length === current.length) {
    return false;
  }
  if (next.length === 0) {
    clearActiveCallLeases();
    return true;
  }
  saveLeaseFile(next);
  return true;
}

export function syncActiveCallLeaseFromSession(
  session: Pick<CallSession, "id" | "providerCallSid" | "status"> | null,
): void {
  if (!session) {
    return;
  }

  if (isTerminalState(session.status)) {
    removeActiveCallLease(session.id);
    return;
  }

  const existing = getActiveCallLease(session.id);
  if (!existing && session.providerCallSid == null) {
    return;
  }

  upsertActiveCallLease({
    callSessionId: session.id,
    providerCallSid: session.providerCallSid,
  });
}

export function reconcileActiveCallLeases(
  sessions: Array<Pick<CallSession, "id" | "providerCallSid" | "status">>,
): void {
  const nextLeases = sessions
    .filter((session) => !isTerminalState(session.status))
    .map((session) => ({
      callSessionId: session.id,
      providerCallSid: session.providerCallSid,
      updatedAt: Date.now(),
    }));

  if (nextLeases.length === 0) {
    clearActiveCallLeases();
    return;
  }

  saveLeaseFile(nextLeases);
}
