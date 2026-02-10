import { Metadata } from "next";
import {
  VellumHead,
  VellumScripts,
  UTMTracker,
} from "@/components/marketing/VellumHomepage";
import { PricingBody } from "@/components/marketing/PricingPage";

export const metadata: Metadata = {
  title: "Pricing - Vellum",
};

export default function PricingPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <UTMTracker />
      <PricingBody />
    </>
  );
}
