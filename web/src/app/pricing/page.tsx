import { Metadata } from "next";
import {
  VellumHead,
  VellumScripts,
  UTMTracker,
} from "@/components/VellumHomepage";
import { PricingBody } from "@/components/PricingPage";

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
