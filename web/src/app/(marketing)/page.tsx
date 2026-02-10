import { Metadata } from "next";
import {
  VellumHead,
  VellumScripts,
  UTMTracker,
  VellumBody,
} from "@/components/marketing/VellumHomepage";

export const metadata: Metadata = {
  title: "Vellum",
  description:
    "Create powerful AI agents by chatting with AI. With Vellum, just describe what you want and your agent starts working. What once took a team of engineers now takes a single conversation.",
  openGraph: {
    title: "Vellum",
    description:
      "Describe what you want your agent to do, and Vellum automatically builds it for you. What once took a team of engineers now takes a single conversation.",
    images: [
      {
        url: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/68e815585c6e16181cb905cf_cover-home-page.jpg",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vellum",
    description:
      "Describe what you want your agent to do, and Vellum automatically builds it for you. What once took a team of engineers now takes a single conversation.",
    images: [
      "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/68e815585c6e16181cb905cf_cover-home-page.jpg",
    ],
  },
  icons: {
    icon: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/670405978c3b31a77bed0c6f_Favicon.png",
    apple:
      "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6430460e0359f61ed2789f03_vellum-icon-256-x-256.png",
  },
};

export default function Home() {
  return (
    <>
      <VellumHead />
      <VellumScripts />
      <UTMTracker />
      <VellumBody />
    </>
  );
}
