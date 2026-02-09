import { Metadata } from "next";

import { N8nToVellumBody } from "@/components/N8nToVellumPage/N8nToVellumBody";
import { VellumHead, VellumScripts } from "@/components/VellumHomepage";

export const metadata: Metadata = {
  title: "N8N to Vellum Converter - Vellum",
};

export default function N8nToVellumPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <N8nToVellumBody />
    </>
  );
}
