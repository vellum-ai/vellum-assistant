import { ExtensibilityToolsContent } from "@/app/docs/_components/extensibility-tools-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Tools - Vellum Docs",
  description:
    "Tools let a plugin add new actions the model can call, landing in the same catalog as the Assistant's built-in tools.",
  path: "/docs/extensibility/tools",
});

export default function ExtensibilityToolsPage() {
  return <ExtensibilityToolsContent />;
}
