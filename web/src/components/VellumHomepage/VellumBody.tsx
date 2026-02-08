"use client";

/**
 * VellumBody Component
 *
 * This component renders the body content from vellum.ai homepage.
 * Currently using dangerouslySetInnerHTML as a bridge solution.
 *
 * TODO: Future improvements (can be done incrementally):
 * - Extract navigation into NavBar component
 * - Extract hero section into Hero component
 * - Extract product sections into ProductShowcase component
 * - Extract footer into Footer component
 * - Convert inline styles to Tailwind/CSS modules
 * - Replace SVGs with proper React components
 */

import { useEffect, useState } from "react";

export function VellumBody() {
  const [bodyHTML, setBodyHTML] = useState<string>("");

  useEffect(() => {
    // Fetch the homepage HTML and extract the body content
    fetch("/vellum-homepage.html")
      .then((res) => res.text())
      .then((html) => {
        // Extract content between <body and </body>
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyMatch && bodyMatch[1]) {
          let bodyContent = bodyMatch[1];
          
          // Replace external auth links with internal routes
          // Replace login links
          bodyContent = bodyContent.replace(
            /href="https:\/\/app\.vellum\.ai"(?![^<]*signup)/g,
            'href="/login"'
          );
          
          // Replace signup links
          bodyContent = bodyContent.replace(
            /href="https:\/\/app\.vellum\.ai\/signup"/g,
            'href="/signup"'
          );
          
          // Also replace any onboarding/agent-builder/signup URLs
          bodyContent = bodyContent.replace(
            /https:\/\/app\.vellum\.ai\/onboarding\/agent-builder\/signup/g,
            '/signup'
          );
          
          setBodyHTML(bodyContent);
        }
      })
      .catch((err) => {
        console.error("Failed to load Vellum homepage:", err);
      });
  }, []);

  if (!bodyHTML) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  return <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />;
}
