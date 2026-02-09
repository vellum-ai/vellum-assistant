import { Metadata } from "next";

import { PrivacyPolicyBody } from "@/components/PrivacyPolicyPage/PrivacyPolicyBody";
import { VellumHead, VellumScripts } from "@/components/VellumHomepage";

export const metadata: Metadata = {
  title: "Privacy Policy - Vellum",
};

export default function PrivacyPolicyPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <PrivacyPolicyBody />
    </>
  );
}
