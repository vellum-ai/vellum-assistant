"use client";

/**
 * VellumBody Component
 *
 * This component renders the body content from vellum.ai homepage (3589 lines of Webflow HTML).
 * Currently loads HTML from /public/vellum-homepage.html and injects React NavBar via portal.
 *
 * CONVERSION STRATEGY: 4-Phase Incremental Approach (see README.md)
 * 
 * Phase 1 ✅ COMPLETE:
 * - NavBar extracted as React component
 * - Auth link replacement working (/login, /signup)
 * - Documentation established
 *
 * Phase 2 ✅ COMPLETE:
 * - Hero section extracted as React component
 * - Logo Marquee extracted as React component
 * - "Automate" section extracted as React component
 *
 * Phase 3 (TODO):
 * - Extract AgentTabs component
 * - Extract PromptBox with animations
 * - Extract video/demo sections
 *
 * Phase 4 (TODO):
 * - Extract Footer
 * - Remove HTML file
 * - Optimize bundle size
 *
 * Why incremental? The Webflow HTML is complex with many interactions.
 * Converting everything at once risks breaking functionality. Each phase
 * can be tested independently before moving to the next.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NavBar } from "./NavBar";
import { HeroSection } from "./HeroSection";
import { LogoMarquee } from "./LogoMarquee";
import { AutomateSection } from "./AutomateSection";

export function VellumBody() {
  const [bodyHTML, setBodyHTML] = useState<string>("");
  const [navbarContainer, setNavbarContainer] = useState<HTMLElement | null>(null);
  const [heroContainer, setHeroContainer] = useState<HTMLElement | null>(null);
  const [logoContainer, setLogoContainer] = useState<HTMLElement | null>(null);
  const [automateContainer, setAutomateContainer] = useState<HTMLElement | null>(null);

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
    // Find and replace sections after HTML is rendered
    if (bodyHTML) {
      setTimeout(() => {
        // Replace NavBar
        const navbar = document.querySelector('#w-node-_45f8248c-ee2e-e6a9-2792-1d703651d480-3651d355');
        if (navbar) {
          navbar.innerHTML = '';
          setNavbarContainer(navbar as HTMLElement);
        }

        // Replace Hero Section (section_home)
        const heroSection = document.querySelector('.section_home.home');
        if (heroSection) {
          heroSection.innerHTML = '';
          setHeroContainer(heroSection as HTMLElement);
        }

        // Replace Logo Marquee (section-logo)
        const logoSection = document.querySelector('.section-logo.new');
        if (logoSection) {
          logoSection.innerHTML = '';
          setLogoContainer(logoSection as HTMLElement);
        }

        // Replace Automate Section (section_automate)
        const automateSection = document.querySelector('.section_automate');
        if (automateSection) {
          automateSection.innerHTML = '';
          setAutomateContainer(automateSection as HTMLElement);
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
      {heroContainer && createPortal(<HeroSection />, heroContainer)}
      {logoContainer && createPortal(<LogoMarquee />, logoContainer)}
      {automateContainer && createPortal(<AutomateSection />, automateContainer)}
    </>
  );
}
