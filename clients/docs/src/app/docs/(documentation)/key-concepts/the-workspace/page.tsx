import { TheWorkspaceContent } from "@/app/docs/_components/the-workspace-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "The Workspace - Vellum Docs",
  description:
    "The Vellum workspace — folder structure, IDENTITY.md, SOUL.md, USER.md, LOOKS.md, config.json, and skills directory.",
  path: "/docs/key-concepts/the-workspace",
});

export default function TheWorkspacePage() {
  return <TheWorkspaceContent />;
}
