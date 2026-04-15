import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getWorkspaceDir } from "../../../../util/platform.js";

interface GmailPreferences {
  /** Sender emails archived in previous sessions — auto-archive candidates. */
  blocklist: string[];
  /** Sender emails the user explicitly kept (deselected) — exclude from future tables. */
  safelist: string[];
}

const PREFS_FILENAME = "gmail-preferences.json";

function getPrefsPath(): string {
  return join(getWorkspaceDir(), "data", PREFS_FILENAME);
}

export function loadPreferences(): GmailPreferences {
  try {
    const raw = readFileSync(getPrefsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GmailPreferences>;
    return {
      blocklist: Array.isArray(parsed.blocklist) ? parsed.blocklist : [],
      safelist: Array.isArray(parsed.safelist) ? parsed.safelist : [],
    };
  } catch {
    return { blocklist: [], safelist: [] };
  }
}

function savePreferences(prefs: GmailPreferences): void {
  const path = getPrefsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2));
}

/** Add sender emails to the blocklist (deduplicated). */
export function addToBlocklist(emails: string[]): void {
  const prefs = loadPreferences();
  const existing = new Set(prefs.blocklist);
  for (const email of emails) {
    const normalized = email.toLowerCase();
    existing.add(normalized);
    // If a sender is blocklisted, remove them from safelist
    const safeIdx = prefs.safelist.indexOf(normalized);
    if (safeIdx !== -1) prefs.safelist.splice(safeIdx, 1);
  }
  prefs.blocklist = [...existing];
  savePreferences(prefs);
}

/** Add sender emails to the safelist (deduplicated). */
export function addToSafelist(emails: string[]): void {
  const prefs = loadPreferences();
  const existing = new Set(prefs.safelist);
  for (const email of emails) {
    const normalized = email.toLowerCase();
    existing.add(normalized);
    // If a sender is safelisted, remove them from blocklist
    const blockIdx = prefs.blocklist.indexOf(normalized);
    if (blockIdx !== -1) prefs.blocklist.splice(blockIdx, 1);
  }
  prefs.safelist = [...existing];
  savePreferences(prefs);
}

/** Remove sender emails from the blocklist. */
export function removeFromBlocklist(emails: string[]): void {
  const prefs = loadPreferences();
  const toRemove = new Set(emails.map((e) => e.toLowerCase()));
  prefs.blocklist = prefs.blocklist.filter((e) => !toRemove.has(e));
  savePreferences(prefs);
}

/** Remove sender emails from the safelist. */
export function removeFromSafelist(emails: string[]): void {
  const prefs = loadPreferences();
  const toRemove = new Set(emails.map((e) => e.toLowerCase()));
  prefs.safelist = prefs.safelist.filter((e) => !toRemove.has(e));
  savePreferences(prefs);
}
