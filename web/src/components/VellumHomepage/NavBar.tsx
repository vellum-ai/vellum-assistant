"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";

const NAV_ARROW = (
  <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor" />
  </svg>
);

export function NavBar() {
  const { isLoggedIn, username, logout } = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div 
      data-collapse="medium" 
      data-animation="default" 
      data-duration="400" 
      data-fs-scrolldisable-element="smart-nav" 
      data-easing="ease" 
      data-easing2="ease" 
      role="banner" 
      className="navbar_component new w-nav"
      style={{
        background: "rgba(255, 255, 255, 0.1)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
      }}
    >
      <div className="navbar2_container">
        <Link href="/" className="navbar2_logo-link w-nav-brand">
          <Image loading="lazy" src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6853f41167390a6658f3fd68_Vellum%20Wordmark%20Logo.svg" alt="" className="navbar2_logo" width={120} height={30} unoptimized />
        </Link>
        <nav role="navigation" className="navbar2_menu is-page-height-tablet w-nav-menu">
          <ul data-fs-scrolldisable-element="preserve" role="list" className="nav_list u-hflex-between-center list-new new w-list-unstyled">
            <li className="nav_list_item new">
              <a aria-label="Go to Pricing" href="/pricing" className="nav_list_link newlink new">Pricing</a>
            </li>
            <li className="nav_list_item new">
              <a aria-label="Go to Community" href="/community" className="nav_list_link newlink new">Community</a>
            </li>
            <li className="nav_list_item new">
              <a aria-label="Go to Use Cases" href="/use-cases" className="nav_list_link newlink new">Use Cases</a>
            </li>
            <li className="nav_list_item new">
              <Link aria-label="Go to Blog" href="/blog" className="nav_list_link newlink new">Blog</Link>
            </li>
            <li className="nav_list_item new">
              <a aria-label="Go to Careers" href="https://jobs.ashbyhq.com/vellum" target="_blank" className="nav_list_link newlink new">Careers</a>
            </li>
          </ul>
        </nav>
        <div className="navbar2_button-wrapper hide-tablet new">
          {isLoggedIn ? (
            <>
              <Link
                href="/assistant"
                className="d-button nav-button-5 cta-get-started new w-inline-block"
                style={{ textDecoration: "none" }}
              >
                <div className="btn-text nav-button-6 new">Meet your assistant</div>
                <div className="btn_arrow nav-button-7 w-embed">{NAV_ARROW}</div>
                <div className="d-button_bg-overlay nav-button-8"></div>
              </Link>
              <div ref={menuRef} className="relative">
                <button
                  onClick={() => setIsMenuOpen(!isMenuOpen)}
                  aria-label="User menu"
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-white/15 text-sm font-semibold text-white"
                >
                  {username ? username.charAt(0).toUpperCase() : "U"}
                </button>
                {isMenuOpen && (
                  <div className="absolute right-0 top-full z-50 mt-2 min-w-40 rounded-lg border border-white/15 bg-zinc-900/95 py-1 backdrop-blur-xl">
                    {username && (
                      <div className="border-b border-white/10 px-4 py-2 text-[13px] font-medium text-white">
                        {username}
                      </div>
                    )}
                    <button
                      onClick={() => {
                        logout();
                        setIsMenuOpen(false);
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-4 py-2 text-left text-[13px] text-white/70 hover:bg-white/10 hover:text-white"
                    >
                      Log out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link href="/login" className="text-block-130" style={{ textDecoration: "none" }}>Log in</Link>
              <Link href="/signup" className="d-button nav-button-5 cta-get-started new w-inline-block" style={{ textDecoration: "none" }}>
                <div className="btn-text nav-button-6 new">Get Started</div>
                <div className="btn_arrow nav-button-7 w-embed">{NAV_ARROW}</div>
                <div className="d-button_bg-overlay nav-button-8"></div>
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
