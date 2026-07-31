import { ProhibitedUseBody } from "@/app/docs/(documentation)/prohibited-use/_components/prohibited-use-body";
import { createMetadata } from "@/lib/metadata";
import { routes } from "@/lib/routes";

export const metadata = createMetadata({
  title: "Prohibited Use Policy - Vellum",
  description:
    "Vellum's prohibited use policy: ensuring the Services are used safely, ethically, and in accordance with all applicable laws and regulations.",
  path: routes.docs.legal.prohibitedUse,
});

export default function ProhibitedUsePage() {
  return <ProhibitedUseBody />;
}
