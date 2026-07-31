import { TermsOfUseBody } from "@/app/docs/(documentation)/vellum-terms-of-use/_components/terms-of-use-body";
import { createMetadata } from "@/lib/metadata";
import { routes } from "@/lib/routes";

export const metadata = createMetadata({
  title: "Terms of Service - Vellum",
  description:
    "Vellum's terms of service: the agreement governing your use of the Vellum AI agent platform and services.",
  path: routes.docs.legal.termsOfUse,
});

export default function TermsOfUsePage() {
  return <TermsOfUseBody />;
}
