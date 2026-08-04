import { ExtensibilityHooksContent } from "@/app/docs/_components/extensibility-hooks-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Hooks - Vellum Docs",
  description:
    "Lifecycle hooks let a plugin run code at fixed points during the Assistant's lifecycle.",
  path: "/docs/extensibility/hooks",
});

export default function ExtensibilityHooksPage() {
  return <ExtensibilityHooksContent />;
}
