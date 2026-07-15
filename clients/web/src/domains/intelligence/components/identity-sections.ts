/**
 * The drill-down sections reachable from the assistant overview page —
 * the replacement for the old About Assistant tab bar. Pure so the
 * capability gating (plugins version gate, channels feature flag) is
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
  /** Plugin routes exist on this assistant (backwards-compat version gate). */
  supportsPlugins: boolean;
  /** The `channel-trust-floors` flag exposes the Channels surface. */
  showChannels: boolean;
  /** The `memory-concept-graph` flag exposes the Memory surface. */
  showMemory: boolean;
}

export function buildIdentitySections({
  supportsPlugins,
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
    {
      key: "skills",
      label: "Skills",
      description: "What I can do",
      to: routes.skills.root,
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
  if (supportsPlugins) {
    sections.push({
      key: "plugins",
      label: "Plugins",
      description: "My add-ons",
      to: routes.plugins,
    });
  }
  sections.push(
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
