import { ExtensibilityRoutesContent } from "@/app/docs/_components/extensibility-routes-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Routes - Vellum Docs",
  description:
    "Routes let a plugin serve HTTP endpoints in its own /x/plugins/<name>/ namespace. Public internet webhooks are declared separately as plugin ingress.",
  path: "/docs/extensibility/routes",
});

export default function ExtensibilityRoutesPage() {
  return <ExtensibilityRoutesContent />;
}
