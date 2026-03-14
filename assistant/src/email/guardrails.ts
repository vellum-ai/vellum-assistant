/**
 * Local guardrails state for email operations.
 * Stores state in ~/.vellum/email-guardrails.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { minimatch } from "minimatch";

import { getRootDir } from "../util/platform.js";

export interface AddressRule {
  id: string;
  type: "block" | "allow";
  pattern: string;
  createdAt: string;
}

interface DailyCount {
  [date: string]: number;
}

interface GuardrailsState {
  paused: boolean;
  dailyCap: number;
  dailyCounts: DailyCount;
  addressRules: AddressRule[];
}

const DEFAULT_STATE: GuardrailsState = {
  paused: false,
  dailyCap: 25,
  dailyCounts: {},
  addressRules: [],
};

function getGuardrailsPath(): string {
  return join(getRootDir(), "email-guardrails.json");
}

function loadState(): GuardrailsState {
  const path = getGuardrailsPath();
  if (!existsSync(path))
    return { ...DEFAULT_STATE, dailyCounts: {}, addressRules: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GuardrailsState>;
    return {
      paused: parsed.paused ?? DEFAULT_STATE.paused,
      dailyCap: parsed.dailyCap ?? DEFAULT_STATE.dailyCap,
      dailyCounts: parsed.dailyCounts ?? {},
      addressRules: parsed.addressRules ?? [],
    };
  } catch {
    return { ...DEFAULT_STATE, dailyCounts: {}, addressRules: [] };
  }
}

function saveState(state: GuardrailsState): void {
  const path = getGuardrailsPath();
  const dir = join(getRootDir());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailySendCount(): number {
  const state = loadState();
  return state.dailyCounts[todayKey()] ?? 0;
}

export function incrementDailySendCount(): number {
  const state = loadState();
  const key = todayKey();
  const newCount = (state.dailyCounts[key] ?? 0) + 1;
  state.dailyCounts[key] = newCount;
  saveState(state);
  return newCount;
}

export function isOutboundPaused(): boolean {
  return loadState().paused;
}

export function setOutboundPaused(paused: boolean): void {
  const state = loadState();
  state.paused = paused;
  saveState(state);
}

export function getDailySendCap(): number {
  return loadState().dailyCap;
}

export function setDailySendCap(cap: number): void {
  const state = loadState();
  state.dailyCap = cap;
  saveState(state);
}

function isAddressAllowed(email: string): {
  allowed: boolean;
  reason?: string;
  rule?: AddressRule;
} {
  const state = loadState();
  const normalized = email.toLowerCase().trim();

  // Check block rules first
  for (const rule of state.addressRules) {
    if (
      rule.type === "block" &&
      minimatch(normalized, rule.pattern, { nocase: true })
    ) {
      return {
        allowed: false,
        reason: `blocked by rule: ${rule.pattern}`,
        rule,
      };
    }
  }

  // If there are allow rules, address must match at least one
  const allowRules = state.addressRules.filter((r) => r.type === "allow");
  if (allowRules.length > 0) {
    const matched = allowRules.some((r) =>
      minimatch(normalized, r.pattern, { nocase: true }),
    );
    if (!matched) {
      return { allowed: false, reason: "not in allowlist" };
    }
  }

  return { allowed: true };
}

export function addAddressRule(
  type: "block" | "allow",
  pattern: string,
): AddressRule {
  const state = loadState();
  const rule: AddressRule = {
    id: crypto.randomUUID(),
    type,
    pattern: pattern.toLowerCase(),
    createdAt: new Date().toISOString(),
  };
  state.addressRules.push(rule);
  saveState(state);
  return rule;
}

export function removeAddressRule(ruleId: string): boolean {
  const state = loadState();
  const idx = state.addressRules.findIndex(
    (r) => r.id === ruleId || r.id.startsWith(ruleId),
  );
  if (idx === -1) return false;
  state.addressRules.splice(idx, 1);
  saveState(state);
  return true;
}

export function listRules(): AddressRule[] {
  return loadState().addressRules;
}

export function getGuardrailsStatus(): {
  paused: boolean;
  dailyCap: number;
  dailyCount: number;
  rules: AddressRule[];
} {
  const state = loadState();
  return {
    paused: state.paused,
    dailyCap: state.dailyCap,
    dailyCount: state.dailyCounts[todayKey()] ?? 0,
    rules: state.addressRules,
  };
}

/**
 * Check all guardrails before sending. Returns null if all clear,
 * or an error object describing what blocked the send.
 */
export function checkSendGuardrails(recipients: string[]): {
  error: string;
  address?: string;
  reason?: string;
  count?: number;
  cap?: number;
} | null {
  if (isOutboundPaused()) {
    return { error: "outbound_paused" };
  }

  const count = getDailySendCount();
  const cap = getDailySendCap();
  if (count >= cap) {
    return { error: "daily_cap_reached", count, cap };
  }

  for (const addr of recipients) {
    const check = isAddressAllowed(addr);
    if (!check.allowed) {
      return { error: "address_blocked", address: addr, reason: check.reason };
    }
  }

  return null;
}

/** @internal Test-only: reset state file path override. */
export { getGuardrailsPath as _getGuardrailsPath };
