import { Metadata } from "next";

import { VellumHead, VellumScripts } from "@/components/marketing/VellumHomepage";
import { WebinarsBody } from "@/components/marketing/WebinarsPage/WebinarsBody";

export const metadata: Metadata = {
  title: "Webinars - Vellum",
};

export default function WebinarsPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <WebinarsBody />
    </>
  );
}
