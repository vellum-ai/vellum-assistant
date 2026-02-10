import { Metadata } from "next";

import { N8nToVellumBody } from "@/components/marketing/N8nToVellumPage/N8nToVellumBody";
import { VellumScripts } from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "N8N to Vellum Converter - Vellum",
};

export default function N8nToVellumPage() {
  return (
    <>
      <VellumScripts />
      <N8nToVellumBody />
    </>
  );
}
