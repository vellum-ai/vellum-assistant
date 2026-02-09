import { Metadata } from "next";

import { AffiliateRulesBody } from "@/components/AffiliateRulesPage/AffiliateRulesBody";
import { VellumHead, VellumScripts } from "@/components/VellumHomepage";

export const metadata: Metadata = {
  title: "Affiliate Program Rules - Vellum",
};

export default function AffiliateRulesPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <AffiliateRulesBody />
    </>
  );
}
