"use client";

/**
 * VellumBody Component
 *
 * This component renders the body content from vellum.ai homepage.
 * Uses React NavBar component for authentication links instead of HTML.
 *
 * TODO: Future improvements (can be done incrementally):
 * - Extract hero section into Hero component
 * - Extract product sections into ProductShowcase component
 * - Extract footer into Footer component
 * - Convert inline styles to Tailwind/CSS modules
 * - Replace SVGs with proper React components
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NavBar } from "./NavBar";

export function VellumBody() {
  const [bodyHTML, setBodyHTML] = useState<string>("");
  const [navbarContainer, setNavbarContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Fetch the homepage HTML and extract the body content
    fetch("/vellum-homepage.html")
      .then((res) => res.text())
      .then((html) => {
        // Extract content between <body and </body>
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyMatch && bodyMatch[1]) {
          let bodyContent = bodyMatch[1];
          
          // Replace any remaining external auth links with internal routes
          bodyContent = bodyContent.replace(
            /href="https:\/\/app\.vellum\.ai\/signup"/g,
            'href="/signup"'
          );
          bodyContent = bodyContent.replace(
            /href="https:\/\/app\.vellum\.ai"(?![^<]*signup)/g,
            'href="/login"'
          );
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

  useEffect(() => {
    // Find and replace the navbar wrapper after HTML is rendered
    if (bodyHTML) {
      setTimeout(() => {
        const navbar = document.querySelector('#w-node-_45f8248c-ee2e-e6a9-2792-1d703651d480-3651d355');
        if (navbar) {
          // Clear the original content
          navbar.innerHTML = '';
          setNavbarContainer(navbar as HTMLElement);
        }
      }, 0);
    }
  }, [bodyHTML]);

  if (!bodyHTML) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />
      {navbarContainer && createPortal(<NavBar />, navbarContainer)}
    </>
  );
}
