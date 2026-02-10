"use client";

import Image from "next/image";
import { useMemo } from "react";

interface BlogPostContentProps {
  content: string;
}

// Normalize text to prevent hydration mismatches from special unicode characters
function normalizeText(text: string): string {
  return text
    .replace(/\u200B/g, '') // zero-width space
    .replace(/\u200D/g, '') // zero-width joiner
    .replace(/\uFEFF/g, '') // byte order mark
    .replace(/\u00A0/g, ' '); // non-breaking space to regular space
}

// Simple markdown-to-JSX renderer for dark theme
export function BlogPostContent({ content }: BlogPostContentProps) {
  const elements = useMemo(() => {
    const normalizedContent = normalizeText(content);
    const lines = normalizedContent.split('\n');
    const result: React.ReactNode[] = [];
    let elementIndex = 0;
    let currentParagraph: string[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let inList = false;
    let listItems: string[] = [];
    let listType: 'ul' | 'ol' = 'ul';

    const getKey = () => `el-${elementIndex++}`;

    const renderInlineMarkdown = (text: string, baseKey: string): React.ReactNode => {
      const parts: React.ReactNode[] = [];
      let remaining = text;
      let keyIndex = 0;
      let plainText = '';

      const flushPlainText = () => {
        if (plainText) {
          parts.push(plainText);
          plainText = '';
        }
      };

      while (remaining.length > 0) {
        // Check for inline code
        const codeMatch = remaining.match(/^`([^`]+)`/);
        if (codeMatch) {
          flushPlainText();
          parts.push(
            <code key={`${baseKey}-c${keyIndex++}`} style={{
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
          flushPlainText();
          parts.push(
            <strong key={`${baseKey}-b${keyIndex++}`} style={{ color: "#ffffff", fontWeight: "600" }}>
              {boldMatch[1]}
            </strong>
          );
          remaining = remaining.slice(boldMatch[0].length);
          continue;
        }

        // Check for italic
        const italicMatch = remaining.match(/^\*([^*]+)\*/);
        if (italicMatch) {
          flushPlainText();
          parts.push(
            <em key={`${baseKey}-i${keyIndex++}`} style={{ color: "#d4d4d8" }}>
              {italicMatch[1]}
            </em>
          );
          remaining = remaining.slice(italicMatch[0].length);
          continue;
        }

        // Check for links
        const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          flushPlainText();
          const isExternal = linkMatch[2].startsWith("http");
          parts.push(
            <a 
              key={`${baseKey}-a${keyIndex++}`}
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

        // No match, accumulate plain text
        plainText += remaining[0];
        remaining = remaining.slice(1);
      }

      flushPlainText();

      // If only one plain string, return it directly
      if (parts.length === 1 && typeof parts[0] === 'string') {
        return parts[0];
      }
      
      return parts;
    };

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        const text = normalizeText(currentParagraph.join(' ').trim());
        if (text) {
          const key = getKey();
          result.push(
            <p key={key} style={{ marginBottom: "1.5rem", color: "#e4e4e7", lineHeight: "1.8" }}>
              {renderInlineMarkdown(text, key)}
            </p>
          );
        }
        currentParagraph = [];
      }
    };

    const flushList = () => {
      if (listItems.length > 0) {
        const ListTag = listType;
        const key = getKey();
        result.push(
          <ListTag key={key} style={{ marginBottom: "1.5rem", paddingLeft: "1.5rem", color: "#e4e4e7" }}>
            {listItems.map((item, i) => (
              <li key={`${key}-li${i}`} style={{ marginBottom: "0.5rem", lineHeight: "1.7" }}>
                {renderInlineMarkdown(normalizeText(item), `${key}-li${i}`)}
              </li>
            ))}
          </ListTag>
        );
        listItems = [];
        inList = false;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code block handling
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          flushParagraph();
          const key = getKey();
          result.push(
            <pre key={key} style={{
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
        const key = getKey();
        result.push(
          <h3 key={key} style={{ fontSize: "1.25rem", fontWeight: "600", marginTop: "2rem", marginBottom: "0.75rem", color: "#ffffff", lineHeight: "1.4" }}>
            {renderInlineMarkdown(normalizeText(line.slice(4)), key)}
          </h3>
        );
        continue;
      }
      if (line.startsWith('## ')) {
        flushParagraph();
        flushList();
        const key = getKey();
        result.push(
          <h2 key={key} style={{ fontSize: "1.5rem", fontWeight: "600", marginTop: "2.5rem", marginBottom: "1rem", color: "#ffffff", lineHeight: "1.3" }}>
            {renderInlineMarkdown(normalizeText(line.slice(3)), key)}
          </h2>
        );
        continue;
      }
      if (line.startsWith('# ')) {
        flushParagraph();
        flushList();
        const key = getKey();
        result.push(
          <h1 key={key} style={{ fontSize: "1.875rem", fontWeight: "700", marginTop: "2.5rem", marginBottom: "1rem", color: "#ffffff", lineHeight: "1.3" }}>
            {renderInlineMarkdown(normalizeText(line.slice(2)), key)}
          </h1>
        );
        continue;
      }

      // Blockquotes
      if (line.startsWith('>')) {
        flushParagraph();
        flushList();
        const key = getKey();
        result.push(
          <blockquote key={key} style={{
            borderLeft: "4px solid #6860ff",
            paddingLeft: "1.25rem",
            marginLeft: 0,
            marginBottom: "1.5rem",
            fontStyle: "italic",
            color: "#a1a1aa"
          }}>
            {renderInlineMarkdown(normalizeText(line.slice(1).trim()), key)}
          </blockquote>
        );
        continue;
      }

      // Horizontal rule
      if (line.match(/^[-*_]{3,}$/)) {
        flushParagraph();
        flushList();
        result.push(
          <hr key={getKey()} style={{ border: "none", borderTop: "1px solid #333", margin: "2rem 0" }} />
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
        const key = getKey();
        result.push(
          <figure key={key} style={{ marginTop: "1.5rem", marginBottom: "1.5rem" }}>
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

    return result;
  }, [content]);

  return <div className="blog-post-content" suppressHydrationWarning>{elements}</div>;
}
