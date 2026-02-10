import { Metadata } from "next";

import { CommunityBody } from "@/components/marketing/CommunityPage/CommunityBody";
import {
  VellumScripts,
  UTMTracker,
} from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "Community - Vellum",
};

export default function CommunityPage() {
  return (
    <>
      <VellumScripts />
      <UTMTracker />
      <CommunityBody />
    </>
  );
}
