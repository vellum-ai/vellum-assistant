"use client";

import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/lib/auth";

const NAV_ARROW = (
  <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor" />
  </svg>
);

export function NavBar() {
  const { isLoggedIn } = useAuth();

  return (
    <div data-collapse="medium" data-animation="default" data-duration="400" data-fs-scrolldisable-element="smart-nav" data-easing="ease" data-easing2="ease" role="banner" className="navbar_component new w-nav">
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
            <Link
              href="/assistant"
              className="d-button nav-button-5 cta-get-started new w-inline-block"
              style={{ textDecoration: "none" }}
            >
              <div className="btn-text nav-button-6 new">Meet your assistant</div>
              <div className="btn_arrow nav-button-7 w-embed">{NAV_ARROW}</div>
              <div className="d-button_bg-overlay nav-button-8"></div>
            </Link>
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
