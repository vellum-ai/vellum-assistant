import { Metadata } from "next";

import { VellumHead, VellumScripts } from "@/components/VellumHomepage";
import { WebinarsBody } from "@/components/WebinarsPage/WebinarsBody";

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
