import { Metadata } from "next";

import { VellumScripts } from "@/components/marketing/VellumHomepage";
import { WebinarsBody } from "@/components/marketing/WebinarsPage/WebinarsBody";

export const metadata: Metadata = {
  title: "Webinars - Vellum",
};

export default function WebinarsPage() {
  return (
    <>
      <VellumScripts />
      <WebinarsBody />
    </>
  );
}
