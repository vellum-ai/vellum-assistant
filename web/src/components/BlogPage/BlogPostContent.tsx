"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Image from "next/image";

interface BlogPostContentProps {
  content: string;
}

export function BlogPostContent({ content }: BlogPostContentProps) {
  return (
    <div className="blog-post-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 style={{ 
              fontSize: "1.875rem", 
              fontWeight: "700", 
              marginTop: "2.5rem", 
              marginBottom: "1rem", 
              color: "#ffffff",
              lineHeight: "1.3"
            }}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ 
              fontSize: "1.5rem", 
              fontWeight: "600", 
              marginTop: "2.5rem", 
              marginBottom: "1rem", 
              color: "#ffffff",
              lineHeight: "1.3"
            }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ 
              fontSize: "1.25rem", 
              fontWeight: "600", 
              marginTop: "2rem", 
              marginBottom: "0.75rem", 
              color: "#ffffff",
              lineHeight: "1.4"
            }}>
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 style={{ 
              fontSize: "1.125rem", 
              fontWeight: "600", 
              marginTop: "1.5rem", 
              marginBottom: "0.5rem", 
              color: "#ffffff",
              lineHeight: "1.4"
            }}>
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p style={{ 
              marginBottom: "1.5rem", 
              color: "#e4e4e7",
              lineHeight: "1.8"
            }}>
              {children}
            </p>
          ),
          a: ({ href, children }) => (
            <a 
              href={href} 
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
              style={{ 
                color: "#a29dff", 
                textDecoration: "underline",
                textUnderlineOffset: "2px"
              }}
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong style={{ color: "#ffffff", fontWeight: "600" }}>
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em style={{ color: "#d4d4d8" }}>
              {children}
            </em>
          ),
          ul: ({ children }) => (
            <ul style={{ 
              marginBottom: "1.5rem", 
              paddingLeft: "1.5rem",
              color: "#e4e4e7"
            }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol style={{ 
              marginBottom: "1.5rem", 
              paddingLeft: "1.5rem",
              color: "#e4e4e7"
            }}>
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li style={{ 
              marginBottom: "0.5rem",
              lineHeight: "1.7"
            }}>
              {children}
            </li>
          ),
          blockquote: ({ children }) => (
            <blockquote style={{ 
              borderLeft: "4px solid #6860ff",
              paddingLeft: "1.25rem",
              marginLeft: 0,
              marginBottom: "1.5rem",
              fontStyle: "italic",
              color: "#a1a1aa"
            }}>
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code style={{
                  backgroundColor: "rgba(104, 96, 255, 0.15)",
                  color: "#a29dff",
                  padding: "0.125rem 0.375rem",
                  borderRadius: "0.25rem",
                  fontSize: "0.9em",
                  fontFamily: "monospace"
                }}>
                  {children}
                </code>
              );
            }
            return (
              <code style={{
                display: "block",
                backgroundColor: "#1a1a1a",
                color: "#e4e4e7",
                padding: "1rem",
                borderRadius: "0.5rem",
                overflow: "auto",
                fontSize: "0.9rem",
                fontFamily: "monospace",
                lineHeight: "1.6"
              }}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre style={{
              backgroundColor: "#1a1a1a",
              borderRadius: "0.5rem",
              marginBottom: "1.5rem",
              overflow: "auto"
            }}>
              {children}
            </pre>
          ),
          img: ({ src, alt }) => {
            const imgSrc = typeof src === "string" ? src : "";
            return (
              <span style={{ 
                display: "block", 
                marginTop: "1.5rem",
                marginBottom: "1.5rem",
                borderRadius: "0.5rem",
                overflow: "hidden"
              }}>
                <Image
                  src={imgSrc}
                  alt={alt || ""}
                  width={800}
                  height={450}
                  style={{ width: "100%", height: "auto", objectFit: "cover" }}
                  unoptimized
                />
                {alt && (
                  <span style={{
                    display: "block",
                    textAlign: "center",
                    fontSize: "0.875rem",
                    color: "#71717a",
                    marginTop: "0.5rem"
                  }}>
                    {alt}
                  </span>
                )}
              </span>
            );
          },
          table: ({ children }) => (
            <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
              <table style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem"
              }}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead style={{ backgroundColor: "#1a1a1a" }}>
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th style={{
              padding: "0.75rem 1rem",
              textAlign: "left",
              borderBottom: "1px solid #333",
              color: "#ffffff",
              fontWeight: "600"
            }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{
              padding: "0.75rem 1rem",
              borderBottom: "1px solid #262626",
              color: "#e4e4e7"
            }}>
              {children}
            </td>
          ),
          hr: () => (
            <hr style={{
              border: "none",
              borderTop: "1px solid #333",
              margin: "2rem 0"
            }} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
