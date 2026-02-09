import { notFound } from "next/navigation";
import Image from "next/image";
import { getBlogPostBySlug, getAllBlogSlugs, formatDate } from "@/lib/blog-content";
import { VellumHead } from "@/components/VellumHomepage/VellumHead";
import { VellumScripts } from "@/components/VellumHomepage/VellumScripts";

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
      <VellumHead />
      <article className="blog-article">
        <div className="u-container" style={{ maxWidth: "800px", margin: "0 auto", padding: "2rem" }}>
          {/* Header */}
          <header style={{ marginBottom: "2rem" }}>
            <div style={{ marginBottom: "1rem" }}>
              <span className="blog_coll_tag" style={{ 
                display: "inline-block",
                padding: "0.25rem 0.75rem",
                backgroundColor: "#f0f0ff",
                borderRadius: "9999px",
                fontSize: "0.875rem",
                color: "#6860ff"
              }}>
                {post.category}
              </span>
            </div>
            <h1 style={{ 
              fontSize: "2.5rem", 
              fontWeight: "bold", 
              lineHeight: "1.2",
              marginBottom: "1rem" 
            }}>
              {post.title}
            </h1>
            <div style={{ 
              display: "flex", 
              gap: "1rem", 
              color: "#667085",
              fontSize: "0.875rem" 
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
              marginBottom: "2rem",
              borderRadius: "0.5rem",
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
            className="blog-content prose"
            style={{ 
              fontSize: "1.125rem",
              lineHeight: "1.8",
              color: "#344054"
            }}
          >
            {/* Render markdown content as HTML-safe paragraphs */}
            {post.content.split('\n\n').map((paragraph, index) => {
              // Handle headers
              if (paragraph.startsWith('### ')) {
                return <h3 key={index} style={{ fontSize: "1.25rem", fontWeight: "600", marginTop: "2rem", marginBottom: "0.5rem" }}>{paragraph.slice(4)}</h3>;
              }
              if (paragraph.startsWith('## ')) {
                return <h2 key={index} style={{ fontSize: "1.5rem", fontWeight: "600", marginTop: "2.5rem", marginBottom: "0.75rem" }}>{paragraph.slice(3)}</h2>;
              }
              if (paragraph.startsWith('# ')) {
                return <h1 key={index} style={{ fontSize: "1.75rem", fontWeight: "700", marginTop: "2.5rem", marginBottom: "1rem" }}>{paragraph.slice(2)}</h1>;
              }
              // Handle blockquotes
              if (paragraph.startsWith('>')) {
                return (
                  <blockquote key={index} style={{ 
                    borderLeft: "4px solid #6860ff",
                    paddingLeft: "1rem",
                    marginLeft: 0,
                    fontStyle: "italic",
                    color: "#667085"
                  }}>
                    {paragraph.slice(1).trim()}
                  </blockquote>
                );
              }
              // Regular paragraphs
              if (paragraph.trim()) {
                return <p key={index} style={{ marginBottom: "1.5rem" }}>{paragraph}</p>;
              }
              return null;
            })}
          </div>
        </div>
      </article>
      <VellumScripts />
    </>
  );
}
