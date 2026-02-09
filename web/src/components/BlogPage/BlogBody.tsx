import { BlogCTA } from "./BlogCTA";
import { BlogFooter } from "./BlogFooter";
import { BlogHero } from "./BlogHero";
import { BlogNewsletter } from "./BlogNewsletter";
import { NavBar } from "@/components/VellumHomepage/NavBar";

export function BlogBody() {
  return (
    <div className="vellum-blog-page">
      <NavBar />
      <BlogHero />
      <BlogNewsletter />
      <BlogCTA />
      <BlogFooter />
    </div>
  );
}
