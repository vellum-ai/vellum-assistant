import { Metadata } from "next";
import {
  VellumHead,
  VellumScripts,
  UTMTracker,
} from "@/components/VellumHomepage";
import { UseCasesBody } from "@/components/UseCasesPage";

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
