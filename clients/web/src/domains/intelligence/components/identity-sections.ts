/**
 * The drill-down sections reachable from the assistant overview page —
 * the replacement for the old About Assistant tab bar. Pure so the
 * capability gating (channels feature flag, memory-graph availability) is
 * unit-testable without rendering the overview.
 */

import { routes } from "@/utils/routes";

export interface IdentitySection {
  key: string;
  label: string;
  /** One playful line under the label — written in the assistant's voice. */
  description: string;
  to: string;
}

export interface IdentitySectionGates {
  /** The `channel-trust-floors` flag exposes the Channels surface. */
  showChannels: boolean;
  /**
   * Whether the memory-concept graph is available for this assistant (memory
   * v3 live, reported by `GET /memory/stats` as `graph_supported`). The Memory
   * surface is native — no feature flag — but only offered where the graph can
   * actually build, so it never dead-ends on a "not available" graph.
   */
  showMemory: boolean;
}

export function buildIdentitySections({
  showChannels,
  showMemory,
}: IdentitySectionGates): IdentitySection[] {
  const sections: IdentitySection[] = [
    {
      key: "personality",
      label: "Personality",
      description: "Tune how I talk",
      to: routes.personality,
    },
    {
      key: "schedules",
      label: "Schedules",
      description: "My routines",
      to: routes.schedules.root,
    },
    // Skills and plugins combined into one list; on assistants without the
    // plugin surface the page itself degrades to skills-only.
    {
      key: "superpowers",
      label: "My Superpowers",
      description: "What I can do",
      to: routes.superpowers,
    },
  ];
  if (showMemory) {
    sections.push({
      key: "memory",
      label: "Memory",
      description: "What I remember",
      to: routes.memory,
    });
  }
  sections.push(
    // Library moved off the nav sidebar and onto the overview strip; it
    // keeps its own top-level page (no About Assistant chrome).
    {
      key: "library",
      label: "Library",
      description: "My apps & docs",
      to: routes.library.root,
    },
    {
      key: "workspace",
      label: "Workspace",
      description: "My files",
      to: routes.workspace,
    },
    {
      key: "contacts",
      label: "Contacts",
      description: "People I know",
      to: routes.contacts.root,
    },
  );
  if (showChannels) {
    sections.push({
      key: "channels",
      label: "Channels",
      description: "Where I listen",
      to: routes.channels,
    });
  }
  return sections;
}
