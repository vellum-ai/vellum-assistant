import { ExtensibilityAppsContent } from "@/app/docs/_components/extensibility-apps-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Apps - Vellum Docs",
  description:
    "Apps let a plugin ship persistent, interactive UI (dashboards, tools, games) served in the workspace panel, built as compiled React.",
  path: "/docs/extensibility/apps",
});

export default function ExtensibilityAppsPage() {
  return <ExtensibilityAppsContent />;
}
