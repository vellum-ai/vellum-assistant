import { TrustSecurityContent } from "@/app/docs/_components/trust-security-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Trust & Security - Vellum Docs",
  description:
    "Vellum trust and security — privacy, data handling, permissions, and deployment best practices.",
  path: "/docs/trust-security",
});

export default function TrustSecurityPage() {
  return <TrustSecurityContent />;
}
