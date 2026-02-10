import { BlogBody } from "@/components/marketing/BlogPage/BlogBody";
import { VellumHead } from "@/components/marketing/VellumHomepage/VellumHead";
import { VellumScripts } from "@/components/marketing/VellumHomepage/VellumScripts";

export const metadata = {
  title: "Blog - Vellum",
};

export default function BlogPage() {
  return (
    <>
      <VellumHead />
      <BlogBody />
      <VellumScripts />
    </>
  );
}
