/**
 * Background context kickoffs. These will eventually warm up the Proof beat
 * with Haiku calls; for now they're no-op async stubs that log. Fire-and-forget
 * — callers don't await them.
 */

import type { JobKey, RatherKey } from "@/cast/cast-content";

export interface StyleProfile {
  execution?: "just_do_it" | "show_work";
  tone?: "sharp" | "warm";
  latitude?: "surprise" | "literal";
}

export async function kickoffJobContext(jobs: JobKey[]): Promise<void> {
  console.log("[Cast] kickoffJobContext", jobs);
}

export async function kickoffRatherContext(rathers: RatherKey[]): Promise<void> {
  console.log("[Cast] kickoffRatherContext", rathers);
}

export async function kickoffStyleContext(style: StyleProfile): Promise<void> {
  console.log("[Cast] kickoffStyleContext", style);
}
