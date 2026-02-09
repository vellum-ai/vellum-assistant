import { Metadata } from "next";

import { LLMLeaderboardBody } from "@/components/LLMLeaderboardPage/LLMLeaderboardBody";
import { VellumHead, VellumScripts } from "@/components/VellumHomepage";

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
