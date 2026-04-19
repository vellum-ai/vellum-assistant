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

interface GmailPreferences {
  blocklist: string[];
  safelist: string[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadPreferences(): GmailPreferences {
  try {
    const raw = readFileSync(PREFS_PATH, "utf-8");
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
// CLI dispatcher
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const action = args["action"];

  if (!action || typeof action !== "string") {
    printError(
      "Missing required argument: --action (list, add-blocklist, add-safelist, remove-blocklist, remove-safelist)",
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

    default:
      printError(
        `Unknown action "${action}". Use list, add-blocklist, add-safelist, remove-blocklist, or remove-safelist.`,
      );
  }
}

if (import.meta.main) {
  main();
}
