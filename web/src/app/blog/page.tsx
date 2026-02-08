import { BlogBody } from "@/components/BlogPage/BlogBody";
import { VellumHead } from "@/components/VellumHomepage/VellumHead";
import { VellumScripts } from "@/components/VellumHomepage/VellumScripts";

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
