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
    <section className="overflow-hidden">
      <div className="u-container is--hero-blog">
        <div className="hero_container_blog u-vflex-center-top gap-prod">
          <div className="u-vflex-center-top gap-medium">
            <h1 className="u-text-h1 blog-text">The Latest Learnings in AI</h1>
            <p className="u-text-regular text-center">
              Drowning in AI information? Experts at Vellum distill the latest and greatest into
              bite-sized articles to keep you informed.
            </p>
          </div>
        </div>

        <BlogList posts={postsWithDates} />
      </div>
      <div className="backface_block page_grad" />
    </section>
  );
}
