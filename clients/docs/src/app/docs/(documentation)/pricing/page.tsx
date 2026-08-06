import { PricingContent } from "@/app/docs/_components/pricing-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Pricing - Vellum Docs",
  description:
    "How Vellum pricing works today: prepaid credits, pending usage, and how to add credits to your account.",
  path: "/docs/pricing",
});

export default function PricingPage() {
  return <PricingContent />;
}
