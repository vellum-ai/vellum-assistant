"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { BlogCTA } from "./BlogCTA";
import { BlogFooter } from "./BlogFooter";
import { BlogHero } from "./BlogHero";
import { BlogNewsletter } from "./BlogNewsletter";

function NavBar() {
  return (
    <div className="navbar2_button-wrapper hide-tablet new">
      <Link
        href="/login"
        className="text-block-130"
        style={{
          textDecoration: "none",
          display: "inline-block",
          marginRight: "1rem",
        }}
      >
        Log in
      </Link>
      <Link
        href="/signup"
        className="d-button nav-button-5 cta-get-started new"
        style={{
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <div className="btn-text nav-button-6 new">Get Started</div>
        <div className="btn_arrow nav-button-7" style={{ width: "20px", height: "20px" }}>
          <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" strokeWidth="1.67" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="d-button_bg-overlay nav-button-8" />
      </Link>
    </div>
  );
}

interface BlogPortalContainers {
  navbar: HTMLElement | null;
  hero: HTMLElement | null;
  newsletter: HTMLElement | null;
  cta: HTMLElement | null;
  footer: HTMLElement | null;
}

const INITIAL_CONTAINERS: BlogPortalContainers = {
  navbar: null,
  hero: null,
  newsletter: null,
  cta: null,
  footer: null,
};

const SECTION_SELECTORS: Array<{ key: keyof BlogPortalContainers; selector: string }> = [
  { key: "navbar", selector: ".navbar2_button-wrapper.hide-tablet" },
  { key: "hero", selector: "section.overflow-hidden" },
  { key: "newsletter", selector: "section.grad_logs" },
  { key: "cta", selector: "section.gradient-cta" },
  { key: "footer", selector: ".section_workflow-cta" },
];

export function BlogBody() {
  const [bodyHTML, setBodyHTML] = useState<string>("");
  const [containers, setContainers] = useState<BlogPortalContainers>(INITIAL_CONTAINERS);

  useEffect(() => {
    fetch("/blog.html")
      .then((res) => res.text())
      .then((html) => {
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyMatch && bodyMatch[1]) {
          let bodyContent = bodyMatch[1];

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
            "/signup"
          );

          setBodyHTML(bodyContent);
        }
      })
      .catch((err) => {
        console.error("Failed to load blog page:", err);
      });
  }, []);

  useEffect(() => {
    if (!bodyHTML) {
      return;
    }

    setTimeout(() => {
      const next: BlogPortalContainers = { ...INITIAL_CONTAINERS };

      for (const { key, selector } of SECTION_SELECTORS) {
        const el = document.querySelector(selector);
        if (el) {
          el.innerHTML = "";
          next[key] = el as HTMLElement;
        }
      }

      setContainers(next);
    }, 0);
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
      {containers.navbar && createPortal(<NavBar />, containers.navbar)}
      {containers.hero && createPortal(<BlogHero />, containers.hero)}
      {containers.newsletter && createPortal(<BlogNewsletter />, containers.newsletter)}
      {containers.cta && createPortal(<BlogCTA />, containers.cta)}
      {containers.footer && createPortal(<BlogFooter />, containers.footer)}
    </>
  );
}
