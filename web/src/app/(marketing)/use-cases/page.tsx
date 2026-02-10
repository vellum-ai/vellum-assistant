import { Metadata } from "next";
import {
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
      <VellumScripts />
      <UTMTracker />
      <UseCasesBody />
    </>
  );
}
