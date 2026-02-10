import { Metadata } from "next";

import { AffiliateRulesBody } from "@/components/marketing/AffiliateRulesPage/AffiliateRulesBody";
import { VellumHead, VellumScripts } from "@/components/marketing/VellumHomepage";

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
