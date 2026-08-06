import { ExtensibilityPluginsContent } from "@/app/docs/_components/extensibility-plugins-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Plugins - Vellum Docs",
  description:
    "How a plugin is laid out on disk, what its package.json manifest declares, and the single @vellumai/plugin-api package every surface imports from.",
  path: "/docs/extensibility/plugins",
});

export default function ExtensibilityPluginsPage() {
  return <ExtensibilityPluginsContent />;
}
