import { Metadata } from "next";

import { LLMLeaderboardBody } from "@/components/marketing/LLMLeaderboardPage/LLMLeaderboardBody";
import { VellumHead, VellumScripts } from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "LLM Leaderboard - Vellum",
};

export default function LLMLeaderboardPage() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <LLMLeaderboardBody />
    </>
  );
}
