import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AppDefinition,
  createApp,
  listApps,
} from "../../memory/app-store.js";
import { resolveBundledDir } from "../../util/bundled-asset.js";
import { getLogger } from "../../util/logger.js";
import {
  HOME_BASE_PREBUILT_DESCRIPTION_PREFIX,
  isPrebuiltHomeBaseApp,
} from "../prebuilt-home-base-updater.js";
// Static import so the JSON is bundled into compiled binaries (avoids ENOENT on $bunfs)
import seedMetadataJson from "./seed-metadata.json" with { type: "json" };

const log = getLogger("home-base-seed");

interface SeedMetadata {
  version: string;
  appName: string;
  starterTasks: string[];
  onboardingTasks: string[];
}

export interface PrebuiltHomeBaseTaskPayload {
  starterTasks: string[];
  onboardingTasks: string[];
}

function getPrebuiltDir(): string {
  return resolveBundledDir(import.meta.dirname ?? __dirname, ".", "prebuilt");
}

function loadSeedMetadata(): SeedMetadata {
  return seedMetadataJson as SeedMetadata;
}

export function loadPrebuiltHtml(): string | null {
  try {
    return readFileSync(join(getPrebuiltDir(), "index.html"), "utf-8");
  } catch {
    log.warn(
      "Could not load prebuilt index.html (expected in compiled binary)",
    );
    return null;
  }
}

function buildDescription(metadata: SeedMetadata): string {
  return [
    `${HOME_BASE_PREBUILT_DESCRIPTION_PREFIX} ${metadata.version}`,
    "Prebuilt Home Base dashboard scaffold seeded during onboarding/bootstrap.",
    `Starter tasks: ${metadata.starterTasks.join(", ")}`,
    `Onboarding tasks: ${metadata.onboardingTasks.join(", ")}`,
  ].join(" ");
}

export function findSeededHomeBaseApp(): AppDefinition | null {
  const apps = listApps();
  for (const app of apps) {
    if (isPrebuiltHomeBaseApp(app)) {
      return app;
    }
  }
  return null;
}

export function getPrebuiltHomeBasePreview(): {
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  metrics: Array<{ label: string; value: string }>;
} {
  return {
    title: "Home Base",
    subtitle: "Dashboard",
    description: "Prebuilt onboarding + starter task canvas",
    icon: "🏠",
    metrics: [
      { label: "Starter tasks", value: "3" },
      { label: "Onboarding tasks", value: "4" },
    ],
  };
}

export function getPrebuiltHomeBaseTaskPayload(): PrebuiltHomeBaseTaskPayload {
  const metadata = loadSeedMetadata();
  return {
    starterTasks: metadata.starterTasks,
    onboardingTasks: metadata.onboardingTasks,
  };
}

export function ensurePrebuiltHomeBaseSeeded(): {
  appId: string;
  created: boolean;
} | null {
  const existing = findSeededHomeBaseApp();
  if (existing) {
    return { appId: existing.id, created: false };
  }

  const metadata = loadSeedMetadata();
  const html = loadPrebuiltHtml();
  if (html == null) {
    log.warn("Skipping Home Base seed — prebuilt HTML not available");
    return null;
  }

  const created = createApp({
    name: metadata.appName,
    description: buildDescription(metadata),
    schemaJson: "{}",
    htmlDefinition: html,
  });

  log.info({ appId: created.id }, "Seeded prebuilt Home Base app");
  return { appId: created.id, created: true };
}
