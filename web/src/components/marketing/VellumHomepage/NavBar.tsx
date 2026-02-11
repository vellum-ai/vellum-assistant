"use client";

import Image from "next/image";
import Link from "next/link";

export function NavBar() {
  return (
    <nav
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        padding: "1.5rem 2rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <Link href="/" style={{ textDecoration: "none" }}>
        <span
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            color: "#0a2540",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          vellum
        </span>
      </Link>
      
      <button
        style={{
          background: "rgba(99, 91, 255, 0.1)",
          border: "none",
          borderRadius: "8px",
          padding: "0.75rem",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        aria-label="Menu"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 12H21M3 6H21M3 18H21" stroke="#635bff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </nav>
  );
}
