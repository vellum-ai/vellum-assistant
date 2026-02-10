import { notFound } from "next/navigation";
import Image from "next/image";
import { getBlogPostBySlug, getAllBlogSlugs, formatDate } from "@/lib/blog-content";
import { VellumScripts } from "@/components/marketing/VellumHomepage/VellumScripts";
import { BlogPostContent } from "@/components/marketing/BlogPage/BlogPostContent";

interface BlogPostPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const slugs = getAllBlogSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = getBlogPostBySlug(slug);
  
  if (!post) {
    return { title: "Blog Post Not Found" };
  }
  
  return {
    title: `${post.title} - Vellum Blog`,
    description: post.excerpt,
  };
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = getBlogPostBySlug(slug);
  
  if (!post) {
    notFound();
  }
  
  return (
    <>
      <article className="blog-article" style={{ backgroundColor: "#0d0d0d", minHeight: "100vh" }}>
        <div className="u-container" style={{ maxWidth: "800px", margin: "0 auto", padding: "4rem 2rem" }}>
          {/* Header */}
          <header style={{ marginBottom: "2.5rem" }}>
            <div style={{ marginBottom: "1rem" }}>
              <span className="blog_coll_tag" style={{ 
                display: "inline-block",
                padding: "0.25rem 0.75rem",
                backgroundColor: "rgba(104, 96, 255, 0.15)",
                borderRadius: "9999px",
                fontSize: "0.875rem",
                color: "#a29dff",
                fontWeight: "500"
              }}>
                {post.category}
              </span>
            </div>
            <h1 style={{ 
              fontSize: "2.75rem", 
              fontWeight: "bold", 
              lineHeight: "1.2",
              marginBottom: "1.25rem",
              color: "#ffffff"
            }}>
              {post.title}
            </h1>
            <div style={{ 
              display: "flex", 
              gap: "0.5rem", 
              color: "#94969c",
              fontSize: "0.9rem" 
            }}>
              <span>{formatDate(post.publishedAt)}</span>
              <span>•</span>
              <span>{post.readTime}</span>
              {post.authors.length > 0 && (
                <>
                  <span>•</span>
                  <span>By {post.authors.join(", ")}</span>
                </>
              )}
            </div>
          </header>
          
          {/* Featured Image */}
          {post.featuredImage && (
            <div style={{ 
              marginBottom: "2.5rem",
              borderRadius: "0.75rem",
              overflow: "hidden"
            }}>
              <Image
                src={post.featuredImage}
                alt={post.title}
                width={800}
                height={450}
                style={{ width: "100%", height: "auto", objectFit: "cover" }}
                unoptimized
              />
            </div>
          )}
          
          {/* Content */}
          <div 
            className="blog-content"
            style={{ 
              fontSize: "1.125rem",
              lineHeight: "1.8"
            }}
          >
            <BlogPostContent content={post.content} />
          </div>
        </div>
      </article>
      <VellumScripts />
    </>
  );
}
