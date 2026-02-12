import { Metadata } from "next";

import { DownloadBody } from "@/components/marketing/DownloadPage/DownloadBody";
import { VellumScripts } from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "Download - Vellum",
};

export default function DownloadPage() {
  return (
    <>
      <VellumScripts />
      <DownloadBody />
    </>
  );
}
