import { TrustSecurityPrivacyDataContent } from "@/app/docs/_components/trust-security-privacy-data-content";
import { createMetadata } from "@/lib/metadata";
import { routes } from "@/lib/routes";

export const metadata = createMetadata({
  title: "Privacy & Data - Vellum Docs",
  description:
    "Vellum privacy and data: what stays local, what leaves your device, and what Vellum never does.",
  path: routes.docs.legal.privacyAndData,
});

export default function TrustSecurityPrivacyDataPage() {
  return <TrustSecurityPrivacyDataContent />;
}
