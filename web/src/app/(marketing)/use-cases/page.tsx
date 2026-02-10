import { Metadata } from "next";
import {
  VellumHead,
  VellumScripts,
  UTMTracker,
} from "@/components/marketing/VellumHomepage";
import { UseCasesBody } from "@/components/marketing/UseCasesPage";

export const metadata: Metadata = {
  title: "Use Cases - Vellum",
};

export default function UseCasesPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <UTMTracker />
      <UseCasesBody />
    </>
  );
}
