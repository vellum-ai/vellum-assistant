"use client";

import { useState, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";

interface BlogPost {
  title: string;
  slug: string;
  href: string;
  excerpt: string;
  category: string;
  publishedAt: string;
  readTime: string;
  featuredImage: string;
  authors: string[];
  isFeatured?: boolean;
  formattedDate: string;
}

interface BlogListProps {
  posts: BlogPost[];
}

const FILTER_CATEGORIES = [
  {
    label: "All",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f50a2cad08bc3b390eb5e9_Icon.svg",
  },
  {
    label: "LLM basics",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f50886f6e3e03c9aef2f2a_Icons.svg",
  },
  {
    label: "Product Updates",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f508ee4ed9a5aab6105f84_Icons.svg",
  },
  {
    label: "Guides",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/670416e02ab0997ea510d76f_Icons.svg",
  },
];

const CATEGORY_STYLES: Record<string, { color: string; bgColor: string; icon?: string }> = {
  "Product Updates": {
    color: "#4ade80",
    bgColor: "rgba(74, 222, 128, 0.15)",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f51fbc4ccaf48d43a691b6_Icon.svg",
  },
  "Guides": {
    color: "#a29dff",
    bgColor: "rgba(162, 157, 255, 0.15)",
  },
  "LLM basics": {
    color: "#fbbf24",
    bgColor: "rgba(251, 191, 36, 0.15)",
  },
  "Customer Stories": {
    color: "#38bdf8",
    bgColor: "rgba(56, 189, 248, 0.15)",
  },
  "Model Comparisons": {
    color: "#c084fc",
    bgColor: "rgba(192, 132, 252, 0.15)",
  },
};

const POSTS_PER_PAGE = 12;

function BlogPostCard({ post }: { post: BlogPost }) {
  const categoryStyle = CATEGORY_STYLES[post.category];
  const tagStyle = categoryStyle
    ? { color: categoryStyle.color, backgroundColor: categoryStyle.bgColor }
    : { color: "#94969c", backgroundColor: "rgba(148, 150, 156, 0.15)" };

  return (
    <article 
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: "12px",
        overflow: "hidden",
        backgroundColor: "#1a1a1a",
        border: "1px solid #262626",
        transition: "border-color 0.2s ease, transform 0.2s ease",
        position: "relative",
      }}
    >
      <div style={{ position: "relative", paddingTop: "56.25%", overflow: "hidden" }}>
        <Image
          src={post.featuredImage}
          alt={post.title}
          fill
          style={{ objectFit: "cover" }}
          unoptimized
        />
      </div>
      <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem", flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <span
            style={{
              ...tagStyle,
              padding: "0.25rem 0.75rem",
              borderRadius: "9999px",
              fontSize: "0.75rem",
              fontWeight: "500",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            {categoryStyle?.icon && (
              <Image src={categoryStyle.icon} alt="" width={12} height={12} unoptimized />
            )}
            {post.category}
          </span>
          <span style={{ fontSize: "0.75rem", color: "#71717a" }}>
            {post.formattedDate} • {post.readTime}
          </span>
        </div>
        <h3 style={{ 
          fontSize: "1rem", 
          fontWeight: "600", 
          color: "#ffffff", 
          lineHeight: "1.4",
          margin: 0,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {post.title}
        </h3>
      </div>
      <Link 
        href={post.href} 
        aria-label={`Read: ${post.title}`}
        style={{ position: "absolute", inset: 0 }}
      />
    </article>
  );
}

export function BlogList({ posts }: BlogListProps) {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);

  const filteredPosts = useMemo(() => {
    if (selectedCategory === "All") {
      return posts;
    }
    return posts.filter(post => post.category === selectedCategory);
  }, [posts, selectedCategory]);

  const totalPages = Math.ceil(filteredPosts.length / POSTS_PER_PAGE);
  
  const paginatedPosts = useMemo(() => {
    const start = (currentPage - 1) * POSTS_PER_PAGE;
    return filteredPosts.slice(start, start + POSTS_PER_PAGE);
  }, [filteredPosts, currentPage]);

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category);
    setCurrentPage(1);
  };

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "0 1.5rem" }}>
      {/* Filter Pills */}
      <div style={{ 
        display: "flex", 
        justifyContent: "center", 
        marginBottom: "2rem",
      }}>
        <div style={{
          display: "inline-flex",
          gap: "0.5rem",
          padding: "0.5rem",
          backgroundColor: "#1a1a1a",
          borderRadius: "9999px",
          border: "1px solid #262626",
        }}>
          {FILTER_CATEGORIES.map((cat) => {
            const isActive = selectedCategory === cat.label;
            return (
              <button
                key={cat.label}
                type="button"
                onClick={() => handleCategoryChange(cat.label)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.625rem 1rem",
                  borderRadius: "9999px",
                  border: "none",
                  backgroundColor: isActive ? "rgba(104, 96, 255, 0.2)" : "transparent",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: isActive ? "600" : "500",
                  color: isActive ? "#a29dff" : "#94969c",
                  transition: "all 0.15s ease",
                }}
              >
                <Image 
                  src={cat.icon} 
                  alt="" 
                  width={18} 
                  height={18} 
                  unoptimized
                  style={{ opacity: isActive ? 1 : 0.6 }}
                />
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Post Count */}
      <div style={{ 
        marginBottom: "1.5rem", 
        fontSize: "0.875rem", 
        color: "#71717a",
      }}>
        <span style={{ fontWeight: "600", color: "#ffffff" }}>{filteredPosts.length}</span>
        {" / "}
        {posts.length} posts
      </div>

      {/* Post Grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: "1.5rem",
        marginBottom: "3rem",
      }}>
        {paginatedPosts.map((post) => (
          <BlogPostCard key={post.href} post={post} />
        ))}
      </div>

      {/* Empty State */}
      {filteredPosts.length === 0 && (
        <div style={{ 
          padding: "4rem 2rem", 
          textAlign: "center",
          color: "#71717a",
        }}>
          <p>No posts found in this category.</p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ 
          display: "flex", 
          justifyContent: "center", 
          alignItems: "center",
          gap: "0.5rem",
          marginTop: "2rem",
          paddingBottom: "2rem",
        }}>
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            style={{ 
              padding: "0.5rem 0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid #333",
              backgroundColor: "#1a1a1a",
              color: currentPage === 1 ? "#4a4a4a" : "#e4e4e7",
              cursor: currentPage === 1 ? "not-allowed" : "pointer",
              fontSize: "0.875rem",
              fontWeight: "500",
            }}
          >
            Previous
          </button>
          
          <div style={{ display: "flex", gap: "0.25rem" }}>
            {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
              let pageNum;
              if (totalPages <= 7) {
                pageNum = i + 1;
              } else if (currentPage <= 4) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 3) {
                pageNum = totalPages - 6 + i;
              } else {
                pageNum = currentPage - 3 + i;
              }
              
              return (
                <button
                  key={pageNum}
                  onClick={() => setCurrentPage(pageNum)}
                  style={{
                    minWidth: "2.25rem",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "0.375rem",
                    border: currentPage === pageNum ? "none" : "1px solid transparent",
                    backgroundColor: currentPage === pageNum ? "#6860ff" : "transparent",
                    color: currentPage === pageNum ? "#fff" : "#94969c",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: currentPage === pageNum ? "600" : "500",
                  }}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            style={{ 
              padding: "0.5rem 0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid #333",
              backgroundColor: "#1a1a1a",
              color: currentPage === totalPages ? "#4a4a4a" : "#e4e4e7",
              cursor: currentPage === totalPages ? "not-allowed" : "pointer",
              fontSize: "0.875rem",
              fontWeight: "500",
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
