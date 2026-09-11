import { AgenticPaymentsContent } from "@/app/docs/_components/agentic-payments-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Agentic Payments - Vellum Docs",
  description:
    "How your assistant pays for things on your behalf through your Link account: approve an amount in the Link app, and it checks out with a single-use virtual card.",
  path: "/docs/key-concepts/agentic-payments",
});

export default function AgenticPaymentsPage() {
  return <AgenticPaymentsContent />;
}
