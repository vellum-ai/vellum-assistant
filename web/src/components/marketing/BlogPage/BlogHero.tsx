import { getAllBlogPosts, formatDate } from "@/lib/blog-content";
import { BlogList } from "./BlogList";

export function BlogHero() {
  // Fetch all blog posts from markdown files at build/render time
  const blogPosts = getAllBlogPosts();
  
  // Transform posts with formatted dates for client component
  const postsWithDates = blogPosts.map(post => ({
    ...post,
    formattedDate: formatDate(post.publishedAt),
  }));

  return (
    <section style={{ paddingTop: "6rem", paddingBottom: "4rem" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "0 1.5rem" }}>
        {/* Hero Header */}
        <div style={{ 
          textAlign: "center", 
          marginBottom: "3rem",
          maxWidth: "700px",
          margin: "0 auto 3rem",
        }}>
          <h1 style={{ 
            fontSize: "clamp(2rem, 5vw, 3rem)", 
            fontWeight: "700", 
            color: "#ffffff",
            marginBottom: "1rem",
            lineHeight: "1.2",
          }}>
            The Latest Learnings in AI
          </h1>
          <p style={{ 
            fontSize: "1.125rem", 
            color: "#94969c",
            lineHeight: "1.6",
          }}>
            Drowning in AI information? Experts at Vellum distill the latest and greatest into
            bite-sized articles to keep you informed.
          </p>
        </div>

        <BlogList posts={postsWithDates} />
      </div>
    </section>
  );
}
