"use client";

import Image from "next/image";

interface BlogPostContentProps {
  content: string;
}

// Simple markdown-to-JSX renderer for dark theme
export function BlogPostContent({ content }: BlogPostContentProps) {
  const renderContent = () => {
    const lines = content.split('\n');
    const elements: React.ReactNode[] = [];
    let currentParagraph: string[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let inList = false;
    let listItems: string[] = [];
    let listType: 'ul' | 'ol' = 'ul';

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        const text = currentParagraph.join(' ').trim();
        if (text) {
          elements.push(
            <p key={elements.length} style={{ marginBottom: "1.5rem", color: "#e4e4e7", lineHeight: "1.8" }}>
              {renderInlineMarkdown(text)}
            </p>
          );
        }
        currentParagraph = [];
      }
    };

    const flushList = () => {
      if (listItems.length > 0) {
        const ListTag = listType;
        elements.push(
          <ListTag key={elements.length} style={{ marginBottom: "1.5rem", paddingLeft: "1.5rem", color: "#e4e4e7" }}>
            {listItems.map((item, i) => (
              <li key={i} style={{ marginBottom: "0.5rem", lineHeight: "1.7" }}>
                {renderInlineMarkdown(item)}
              </li>
            ))}
          </ListTag>
        );
        listItems = [];
        inList = false;
      }
    };

    const renderInlineMarkdown = (text: string): React.ReactNode => {
      // Handle inline code, bold, italic, and links
      const parts: React.ReactNode[] = [];
      let remaining = text;
      let keyIndex = 0;

      while (remaining.length > 0) {
        // Check for inline code
        const codeMatch = remaining.match(/^`([^`]+)`/);
        if (codeMatch) {
          parts.push(
            <code key={keyIndex++} style={{
              backgroundColor: "rgba(104, 96, 255, 0.15)",
              color: "#a29dff",
              padding: "0.125rem 0.375rem",
              borderRadius: "0.25rem",
              fontSize: "0.9em",
              fontFamily: "monospace"
            }}>
              {codeMatch[1]}
            </code>
          );
          remaining = remaining.slice(codeMatch[0].length);
          continue;
        }

        // Check for bold
        const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
        if (boldMatch) {
          parts.push(<strong key={keyIndex++} style={{ color: "#ffffff", fontWeight: "600" }}>{boldMatch[1]}</strong>);
          remaining = remaining.slice(boldMatch[0].length);
          continue;
        }

        // Check for italic
        const italicMatch = remaining.match(/^\*([^*]+)\*/);
        if (italicMatch) {
          parts.push(<em key={keyIndex++} style={{ color: "#d4d4d8" }}>{italicMatch[1]}</em>);
          remaining = remaining.slice(italicMatch[0].length);
          continue;
        }

        // Check for links
        const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          const isExternal = linkMatch[2].startsWith("http");
          parts.push(
            <a 
              key={keyIndex++}
              href={linkMatch[2]}
              target={isExternal ? "_blank" : undefined}
              rel={isExternal ? "noopener noreferrer" : undefined}
              style={{ color: "#a29dff", textDecoration: "underline", textUnderlineOffset: "2px" }}
            >
              {linkMatch[1]}
            </a>
          );
          remaining = remaining.slice(linkMatch[0].length);
          continue;
        }

        // No match, consume one character
        parts.push(remaining[0]);
        remaining = remaining.slice(1);
      }

      return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code block handling
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          flushParagraph();
          elements.push(
            <pre key={elements.length} style={{
              backgroundColor: "#1a1a1a",
              borderRadius: "0.5rem",
              marginBottom: "1.5rem",
              overflow: "auto",
              padding: "1rem"
            }}>
              <code style={{ color: "#e4e4e7", fontSize: "0.9rem", fontFamily: "monospace", lineHeight: "1.6" }}>
                {codeBlockContent.join('\n')}
              </code>
            </pre>
          );
          codeBlockContent = [];
          inCodeBlock = false;
        } else {
          flushParagraph();
          flushList();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
        continue;
      }

      // Headers
      if (line.startsWith('### ')) {
        flushParagraph();
        flushList();
        elements.push(
          <h3 key={elements.length} style={{ fontSize: "1.25rem", fontWeight: "600", marginTop: "2rem", marginBottom: "0.75rem", color: "#ffffff", lineHeight: "1.4" }}>
            {renderInlineMarkdown(line.slice(4))}
          </h3>
        );
        continue;
      }
      if (line.startsWith('## ')) {
        flushParagraph();
        flushList();
        elements.push(
          <h2 key={elements.length} style={{ fontSize: "1.5rem", fontWeight: "600", marginTop: "2.5rem", marginBottom: "1rem", color: "#ffffff", lineHeight: "1.3" }}>
            {renderInlineMarkdown(line.slice(3))}
          </h2>
        );
        continue;
      }
      if (line.startsWith('# ')) {
        flushParagraph();
        flushList();
        elements.push(
          <h1 key={elements.length} style={{ fontSize: "1.875rem", fontWeight: "700", marginTop: "2.5rem", marginBottom: "1rem", color: "#ffffff", lineHeight: "1.3" }}>
            {renderInlineMarkdown(line.slice(2))}
          </h1>
        );
        continue;
      }

      // Blockquotes
      if (line.startsWith('>')) {
        flushParagraph();
        flushList();
        elements.push(
          <blockquote key={elements.length} style={{
            borderLeft: "4px solid #6860ff",
            paddingLeft: "1.25rem",
            marginLeft: 0,
            marginBottom: "1.5rem",
            fontStyle: "italic",
            color: "#a1a1aa"
          }}>
            {renderInlineMarkdown(line.slice(1).trim())}
          </blockquote>
        );
        continue;
      }

      // Horizontal rule
      if (line.match(/^[-*_]{3,}$/)) {
        flushParagraph();
        flushList();
        elements.push(
          <hr key={elements.length} style={{ border: "none", borderTop: "1px solid #333", margin: "2rem 0" }} />
        );
        continue;
      }

      // Unordered list
      const ulMatch = line.match(/^[-*+]\s+(.+)/);
      if (ulMatch) {
        flushParagraph();
        if (!inList || listType !== 'ul') {
          flushList();
          inList = true;
          listType = 'ul';
        }
        listItems.push(ulMatch[1]);
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^\d+\.\s+(.+)/);
      if (olMatch) {
        flushParagraph();
        if (!inList || listType !== 'ol') {
          flushList();
          inList = true;
          listType = 'ol';
        }
        listItems.push(olMatch[1]);
        continue;
      }

      // Images
      const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
      if (imgMatch) {
        flushParagraph();
        flushList();
        elements.push(
          <figure key={elements.length} style={{ marginTop: "1.5rem", marginBottom: "1.5rem" }}>
            <Image
              src={imgMatch[2]}
              alt={imgMatch[1]}
              width={800}
              height={450}
              style={{ width: "100%", height: "auto", objectFit: "cover", borderRadius: "0.5rem" }}
              unoptimized
            />
            {imgMatch[1] && (
              <figcaption style={{ textAlign: "center", fontSize: "0.875rem", color: "#71717a", marginTop: "0.5rem" }}>
                {imgMatch[1]}
              </figcaption>
            )}
          </figure>
        );
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        flushParagraph();
        flushList();
        continue;
      }

      // Regular text
      currentParagraph.push(line);
    }

    flushParagraph();
    flushList();

    return elements;
  };

  return <div className="blog-post-content">{renderContent()}</div>;
}
