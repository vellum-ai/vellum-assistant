import { Metadata } from "next";

import { AffiliateRulesBody } from "@/components/marketing/AffiliateRulesPage/AffiliateRulesBody";
import { VellumScripts } from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "Affiliate Program Rules - Vellum",
};

export default function AffiliateRulesPage() {
  return (
    <>
      <VellumScripts />
      <AffiliateRulesBody />
    </>
  );
}
