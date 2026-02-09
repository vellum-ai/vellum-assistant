import { Metadata } from "next";

import { TermsOfUseBody } from "@/components/TermsOfUsePage/TermsOfUseBody";
import { VellumHead, VellumScripts } from "@/components/VellumHomepage";

export const metadata: Metadata = {
  title: "Terms of Use - Vellum",
};

export default function TermsOfUsePage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <TermsOfUseBody />
    </>
  );
}
