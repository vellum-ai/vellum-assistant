import { Metadata } from "next";

import { RequestDemoBody } from "@/components/marketing/RequestDemoPage/RequestDemoBody";
import { VellumHead, VellumScripts } from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "Request Demo - Vellum",
};

export default function RequestDemoPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <RequestDemoBody />
    </>
  );
}
