import { Metadata } from "next";

import { TermsOfUseBody } from "@/components/marketing/TermsOfUsePage/TermsOfUseBody";
import { VellumScripts } from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "Terms of Use - Vellum",
};

export default function TermsOfUsePage() {
  return (
    <>
      <VellumScripts />
      <TermsOfUseBody />
    </>
  );
}
