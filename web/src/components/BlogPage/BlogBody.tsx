import { BlogFooter } from "./BlogFooter";
import { BlogHero } from "./BlogHero";
import { NavBar } from "@/components/VellumHomepage/NavBar";

export function BlogBody() {
  return (
    <div style={{ backgroundColor: "#0d0d0d", minHeight: "100vh" }}>
      <NavBar />
      <BlogHero />
      <BlogFooter />
    </div>
  );
}
