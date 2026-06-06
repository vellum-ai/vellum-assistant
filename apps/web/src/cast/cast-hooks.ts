/**
 * Background context kickoffs. These will eventually warm up the Proof beat
 * with Haiku calls; for now they're no-op async stubs that log. Fire-and-forget
 * — callers don't await them.
 */

import type { JobKey, RatherKey } from "@/cast/cast-content";

export interface StyleProfile {
  autonomy?: "send_it" | "show_me";
  tone?: "point" | "walk";
  shape?: "one" | "few";
}

export async function kickoffJobContext(jobs: JobKey[]): Promise<void> {
  console.log("[Cast] kickoffJobContext", jobs);
}

export async function kickoffRatherContext(rathers: RatherKey[]): Promise<void> {
  console.log("[Cast] kickoffRatherContext", rathers);
}

/** Fires on every This/That tap so real Haiku warm-ups can slot in later
 * (same call-site pattern as the job/rather kickoffs). */
export async function kickoffStyleContext(round: number, choice: string): Promise<void> {
  console.log("[Cast] kickoffStyleContext", { round, choice });
}
