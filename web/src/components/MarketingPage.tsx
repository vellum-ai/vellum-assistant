"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";

interface MarketingPageProps {
  htmlFile: string;
  title?: string;
}

function NavBar() {
  return (
    <div className="navbar2_button-wrapper hide-tablet new">
      <Link 
        href="/login" 
        className="text-block-130"
        style={{
          textDecoration: 'none',
          display: 'inline-block',
          marginRight: '1rem'
        }}
      >
        Log in
      </Link>
      <Link 
        href="/signup" 
        className="d-button nav-button-5 cta-get-started new"
        style={{
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem'
        }}
      >
        <div className="btn-text nav-button-6 new">Get Started</div>
        <div className="btn_arrow nav-button-7" style={{ width: '20px', height: '20px' }}>
          <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" strokeWidth="1.67" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="d-button_bg-overlay nav-button-8"></div>
      </Link>
    </div>
  );
}

export function MarketingPage({ htmlFile, title }: MarketingPageProps) {
  const [bodyHTML, setBodyHTML] = useState<string>("");
  const [navbarContainer, setNavbarContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Fetch the page HTML and extract the body content
    fetch(`/${htmlFile}`)
      .then((res) => res.text())
      .then((html) => {
        // Extract content between <body and </body>
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyMatch && bodyMatch[1]) {
          let bodyContent = bodyMatch[1];
          
          // Replace any external auth links with internal routes
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
        console.error(`Failed to load ${htmlFile}:`, err);
      });
  }, [htmlFile]);

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

  useEffect(() => {
    if (title && typeof document !== 'undefined') {
      document.title = title;
    }
  }, [title]);

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
