import { BlogBody } from "@/components/marketing/BlogPage/BlogBody";
import { VellumScripts } from "@/components/marketing/VellumHomepage/VellumScripts";

export const metadata = {
  title: "Blog - Vellum",
};

export default function BlogPage() {
  return (
    <>
      <BlogBody />
      <VellumScripts />
    </>
  );
}
