import { EnvironmentsContent } from "@/app/docs/_components/environments-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Environments - Vellum Docs",
  description:
    "Choose a deployment environment for Vellum: Vellum Cloud (recommended), local, or user-hosted (GCP/AWS/custom), with trade-offs for each.",
  path: "/docs/environments",
});

export default function EnvironmentsPage() {
  return <EnvironmentsContent />;
}
