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
    color: "#12b76a",
    bgColor: "#ecfdf5",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f51fbc4ccaf48d43a691b6_Icon.svg",
  },
  "Guides": {
    color: "#6860ff",
    bgColor: "#f0f0ff",
  },
  "LLM basics": {
    color: "#f79009",
    bgColor: "#fffaeb",
  },
};

const POSTS_PER_PAGE = 12;

function BlogPostCard({ post }: { post: BlogPost }) {
  const categoryStyle = CATEGORY_STYLES[post.category];
  const hasCustomCategory = categoryStyle?.color && categoryStyle?.bgColor;
  const style = hasCustomCategory
    ? { color: categoryStyle.color, backgroundColor: categoryStyle.bgColor }
    : undefined;

  return (
    <div role="listitem" className="blog_coll_item u-vflex-stretch-top w-dyn-item">
      <div className="blog_coll_wrap">
        <Image
          src={post.featuredImage}
          alt=""
          className="blog_coll_image"
          width={400}
          height={225}
          style={{ width: "100%", height: "auto", objectFit: "cover" }}
          unoptimized
        />
      </div>
      <div className="blog_coll_body u-vflex-stretch-top">
        <div className="u-hflex-between-center">
          <div
            className={`blog_coll_tag u-hflex-left-center${hasCustomCategory ? " is--green" : ""}`}
            style={style}
          >
            {categoryStyle?.icon ? (
              <Image src={categoryStyle.icon} loading="lazy" alt="" className="blog_coll_icon" width={16} height={16} unoptimized />
            ) : null}
            <div>{post.category}</div>
          </div>
          <div className="u-hflex-center-center gap-filters">
            <div className="info_small_text">{post.formattedDate}</div>
            <div className="info_small_text">&bull;</div>
            <div className="info_small_text">{post.readTime}</div>
          </div>
        </div>
        <div className="blog_coll_title u-text-regular">{post.title}</div>
      </div>
      <Link aria-label="Go to blog post" href={post.href} className="u-cover-absolute w-inline-block" />
    </div>
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
    <>
      <div className="u-hflex-center-center">
        <div className="filters_wrap">
          <div className="filters_form_block w-form">
            <div className="pad-bot-20">
              <div className="pad-bot u-hflex-center-center w-dyn-list">
                <div role="list" className="filters_form tabs_navigation u-hflex-center-center w-dyn-items">
                  {FILTER_CATEGORIES.map((cat) => (
                    <div key={cat.label} role="listitem" className="w-dyn-item">
                      <button
                        type="button"
                        className={`filters_button u-hflex-center-center${selectedCategory === cat.label ? " is--active" : ""}`}
                        onClick={() => handleCategoryChange(cat.label)}
                        style={{
                          background: selectedCategory === cat.label ? "rgba(104, 96, 255, 0.1)" : "transparent",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        <Image src={cat.icon} alt="" className="tabs_button_icon is--blog" width={20} height={20} unoptimized />
                        <span className="rb_label" style={{ marginLeft: "0.5rem" }}>{cat.label}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="u-hflex-between-center gap-main">
                <div className="status_text">
                  <span className="status_active">{filteredPosts.length}</span>
                  {" / "}
                  <span className="status_total">{posts.length}</span>
                  {" posts"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="w-dyn-list">
        <div className="blog_coll_list w-dyn-items" role="list">
          {paginatedPosts.map((post) => (
            <BlogPostCard key={post.href} post={post} />
          ))}
        </div>

        {filteredPosts.length === 0 && (
          <div className="empty_state u-vflex-center-center" style={{ padding: "3rem", textAlign: "center" }}>
            <p>No posts found in this category.</p>
          </div>
        )}

        {totalPages > 1 && (
          <div role="navigation" aria-label="Pagination" className="w-pagination-wrapper pagination u-hflex-center-center" style={{ marginTop: "2rem", gap: "0.5rem" }}>
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="pagination_page_button"
              style={{ 
                opacity: currentPage === 1 ? 0.5 : 1,
                cursor: currentPage === 1 ? "default" : "pointer",
                border: "none",
                background: "transparent"
              }}
            >
              ←
            </button>
            
            <div className="u-hflex-center-center gap-filters">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum;
                if (totalPages <= 5) {
                  pageNum = i + 1;
                } else if (currentPage <= 3) {
                  pageNum = i + 1;
                } else if (currentPage >= totalPages - 2) {
                  pageNum = totalPages - 4 + i;
                } else {
                  pageNum = currentPage - 2 + i;
                }
                
                return (
                  <button
                    key={pageNum}
                    onClick={() => setCurrentPage(pageNum)}
                    className="pagination_page_button"
                    style={{
                      background: currentPage === pageNum ? "#6860ff" : "transparent",
                      color: currentPage === pageNum ? "#fff" : "#667085",
                      border: "none",
                      cursor: "pointer",
                      padding: "0.5rem 0.75rem",
                      borderRadius: "0.25rem",
                    }}
                  >
                    {pageNum}
                  </button>
                );
              })}
              {totalPages > 5 && currentPage < totalPages - 2 && (
                <>
                  <span className="pagination_page_button">..</span>
                  <button
                    onClick={() => setCurrentPage(totalPages)}
                    className="pagination_page_button"
                    style={{ border: "none", background: "transparent", cursor: "pointer" }}
                  >
                    {totalPages}
                  </button>
                </>
              )}
            </div>

            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="pagination_page_button"
              style={{ 
                opacity: currentPage === totalPages ? 0.5 : 1,
                cursor: currentPage === totalPages ? "default" : "pointer",
                border: "none",
                background: "transparent"
              }}
            >
              →
            </button>
          </div>
        )}
      </div>
    </>
  );
}
