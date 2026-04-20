#!/usr/bin/env bun

/**
 * File-based Gmail preferences management.
 * Manages blocklist and safelist for sender email addresses.
 * Subcommands: list, add-blocklist, add-safelist, remove-blocklist, remove-safelist
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseArgs, printError, ok, parseCsv } from "./lib/common.js";

// ---------------------------------------------------------------------------
// Preferences file location
// ---------------------------------------------------------------------------

const SKILL_ROOT = path.resolve(import.meta.dir, "..");
const PREFS_PATH = path.join(SKILL_ROOT, "data", "gmail-preferences.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxManagementConfig {
  stage: 0 | 1 | 2;
  "interrupt-threshold": "default" | "high" | "low";
  "last-run": string | null;
}

interface GmailPreferences {
  blocklist: string[];
  safelist: string[];
  "inbox-management"?: InboxManagementConfig;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadPreferences(): GmailPreferences {
  try {
    const raw = readFileSync(PREFS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GmailPreferences>;
    const prefs: GmailPreferences = {
      blocklist: Array.isArray(parsed.blocklist) ? parsed.blocklist : [],
      safelist: Array.isArray(parsed.safelist) ? parsed.safelist : [],
    };
    if (parsed["inbox-management"]) {
      prefs["inbox-management"] = parsed["inbox-management"];
    }
    return prefs;
  } catch {
    return { blocklist: [], safelist: [] };
  }
}

function savePreferences(prefs: GmailPreferences): void {
  mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Add sender emails to the blocklist (deduplicated, mutual exclusion with safelist). */
export function addToBlocklist(emails: string[]): void {
  const prefs = loadPreferences();
  const blockSet = new Set(prefs.blocklist);
  const safeSet = new Set(prefs.safelist);

  for (const email of emails) {
    const normalized = email.toLowerCase();
    blockSet.add(normalized);
    safeSet.delete(normalized);
  }

  prefs.blocklist = [...blockSet];
  prefs.safelist = [...safeSet];
  savePreferences(prefs);
}

/** Add sender emails to the safelist (deduplicated, mutual exclusion with blocklist). */
function addToSafelist(emails: string[]): void {
  const prefs = loadPreferences();
  const safeSet = new Set(prefs.safelist);
  const blockSet = new Set(prefs.blocklist);

  for (const email of emails) {
    const normalized = email.toLowerCase();
    safeSet.add(normalized);
    blockSet.delete(normalized);
  }

  prefs.safelist = [...safeSet];
  prefs.blocklist = [...blockSet];
  savePreferences(prefs);
}

/** Remove sender emails from the blocklist. */
function removeFromBlocklist(emails: string[]): void {
  const prefs = loadPreferences();
  const toRemove = new Set(emails.map((e) => e.toLowerCase()));
  prefs.blocklist = prefs.blocklist.filter((e) => !toRemove.has(e));
  savePreferences(prefs);
}

/** Remove sender emails from the safelist. */
function removeFromSafelist(emails: string[]): void {
  const prefs = loadPreferences();
  const toRemove = new Set(emails.map((e) => e.toLowerCase()));
  prefs.safelist = prefs.safelist.filter((e) => !toRemove.has(e));
  savePreferences(prefs);
}

// ---------------------------------------------------------------------------
// Inbox management config
// ---------------------------------------------------------------------------

const DEFAULT_MANAGEMENT_CONFIG: InboxManagementConfig = {
  stage: 0,
  "interrupt-threshold": "default",
  "last-run": null,
};

function getManagementConfig(): InboxManagementConfig {
  const prefs = loadPreferences();
  return { ...DEFAULT_MANAGEMENT_CONFIG, ...prefs["inbox-management"] };
}

function setManagementConfig(updates: Partial<InboxManagementConfig>): void {
  const prefs = loadPreferences();
  const current = { ...DEFAULT_MANAGEMENT_CONFIG, ...prefs["inbox-management"] };
  prefs["inbox-management"] = { ...current, ...updates };
  savePreferences(prefs);
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const action = args["action"];

  if (!action || typeof action !== "string") {
    printError(
      "Missing required argument: --action (list, add-blocklist, add-safelist, remove-blocklist, remove-safelist, get-management-config, set-management-config)",
    );
  }

  switch (action) {
    case "list": {
      const prefs = loadPreferences();
      ok({
        blocklist: prefs.blocklist,
        safelist: prefs.safelist,
        blocklistCount: prefs.blocklist.length,
        safelistCount: prefs.safelist.length,
      });
      break;
    }

    case "add-blocklist": {
      const emails = args["emails"];
      if (!emails || typeof emails !== "string") {
        printError("Missing required argument: --emails");
      }
      addToBlocklist(parseCsv(emails as string));
      const prefs = loadPreferences();
      ok({
        blocklist: prefs.blocklist,
        safelist: prefs.safelist,
        blocklistCount: prefs.blocklist.length,
        safelistCount: prefs.safelist.length,
      });
      break;
    }

    case "add-safelist": {
      const emails = args["emails"];
      if (!emails || typeof emails !== "string") {
        printError("Missing required argument: --emails");
      }
      addToSafelist(parseCsv(emails as string));
      const prefs = loadPreferences();
      ok({
        blocklist: prefs.blocklist,
        safelist: prefs.safelist,
        blocklistCount: prefs.blocklist.length,
        safelistCount: prefs.safelist.length,
      });
      break;
    }

    case "remove-blocklist": {
      const emails = args["emails"];
      if (!emails || typeof emails !== "string") {
        printError("Missing required argument: --emails");
      }
      removeFromBlocklist(parseCsv(emails as string));
      const prefs = loadPreferences();
      ok({
        blocklist: prefs.blocklist,
        safelist: prefs.safelist,
        blocklistCount: prefs.blocklist.length,
        safelistCount: prefs.safelist.length,
      });
      break;
    }

    case "remove-safelist": {
      const emails = args["emails"];
      if (!emails || typeof emails !== "string") {
        printError("Missing required argument: --emails");
      }
      removeFromSafelist(parseCsv(emails as string));
      const prefs = loadPreferences();
      ok({
        blocklist: prefs.blocklist,
        safelist: prefs.safelist,
        blocklistCount: prefs.blocklist.length,
        safelistCount: prefs.safelist.length,
      });
      break;
    }

    case "get-management-config": {
      ok(getManagementConfig());
      break;
    }

    case "set-management-config": {
      const updates: Partial<InboxManagementConfig> = {};
      if (args["stage"] != null) {
        const stage = Number(args["stage"]);
        if (stage !== 0 && stage !== 1 && stage !== 2) {
          printError("--stage must be 0, 1, or 2");
        }
        updates.stage = stage as 0 | 1 | 2;
      }
      if (args["interrupt-threshold"] != null) {
        const threshold = args["interrupt-threshold"] as string;
        if (threshold !== "default" && threshold !== "high" && threshold !== "low") {
          printError('--interrupt-threshold must be "default", "high", or "low"');
        }
        updates["interrupt-threshold"] = threshold as "default" | "high" | "low";
      }
      if (args["last-run"] != null) {
        updates["last-run"] = args["last-run"] as string;
      }
      setManagementConfig(updates);
      ok(getManagementConfig());
      break;
    }

    default:
      printError(
        `Unknown action "${action}". Use list, add-blocklist, add-safelist, remove-blocklist, remove-safelist, get-management-config, or set-management-config.`,
      );
  }
}

if (import.meta.main) {
  main();
}
