"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

export function NavBar() {
  const { isLoggedIn } = useAuth();

  if (isLoggedIn) {
    return (
      <div className="navbar2_button-wrapper hide-tablet new">
        <Link
          href="/assistant"
          className="d-button nav-button-5 cta-get-started new"
          style={{
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <div className="btn-text nav-button-6 new">Meet your assistant</div>
          <div
            className="btn_arrow nav-button-7"
            style={{ width: "20px", height: "20px" }}
          >
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M7.5 15L12.5 10L7.5 5"
                stroke="currentColor"
                strokeWidth="1.67"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="d-button_bg-overlay nav-button-8"></div>
        </Link>
      </div>
    );
  }

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
        <div
          className="btn_arrow nav-button-7"
          style={{ width: "20px", height: "20px" }}
        >
          <svg
            width="100%"
            height="100%"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M7.5 15L12.5 10L7.5 5"
              stroke="currentColor"
              strokeWidth="1.67"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="d-button_bg-overlay nav-button-8"></div>
      </Link>
    </div>
  );
}
