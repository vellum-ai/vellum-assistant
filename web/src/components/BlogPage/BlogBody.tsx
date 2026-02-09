import { BlogCTA } from "./BlogCTA";
import { BlogFooter } from "./BlogFooter";
import { BlogHero } from "./BlogHero";
import { BlogNewsletter } from "./BlogNewsletter";
import { NavBar } from "@/components/VellumHomepage/NavBar";

export function BlogBody() {
  return (
    <div style={{ backgroundColor: "#0d0d0d", minHeight: "100vh" }}>
      <NavBar />
      <BlogHero />
      <BlogNewsletter />
      <BlogCTA />
      <BlogFooter />
    </div>
  );
}
