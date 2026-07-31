import { TrustSecurityPermissionsModelContent } from "@/app/docs/_components/trust-security-permissions-model-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "The Permissions Model - Vellum Docs",
  description:
    "Vellum's permissions model: risk tolerance tiers, sandbox boundary, trust rules, and the Allow/Deny permission prompt.",
  path: "/docs/trust-security/the-permissions-model",
});

export default function TrustSecurityPermissionsModelPage() {
  return <TrustSecurityPermissionsModelContent />;
}
