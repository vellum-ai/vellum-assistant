import { ExtensibilityRoutesContent } from "@/app/docs/_components/extensibility-routes-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Routes - Vellum Docs",
  description:
    "Routes let a plugin serve HTTP endpoints (webhooks, integrations, callbacks) in its own /x/plugins/<name>/ namespace.",
  path: "/docs/extensibility/routes",
});

export default function ExtensibilityRoutesPage() {
  return <ExtensibilityRoutesContent />;
}
