import { Metadata } from "next";

import { CommunityBody } from "@/components/CommunityPage/CommunityBody";
import {
  VellumHead,
  VellumScripts,
  UTMTracker,
} from "@/components/VellumHomepage";

export const metadata: Metadata = {
  title: "Community - Vellum",
};

export default function CommunityPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <UTMTracker />
      <CommunityBody />
    </>
  );
}
