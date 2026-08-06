import { DeveloperGuideSecurityContent } from "@/app/docs/_components/developer-guide-security-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security & Permissions - Developer Guide - Vellum Docs",
  description:
    "Sandbox model, credential storage, trust rules, and permission modes for the Vellum Assistant platform.",
  path: "/docs/developer-guide/security",
});

export default function DeveloperGuideSecurityPage() {
  return <DeveloperGuideSecurityContent />;
}
