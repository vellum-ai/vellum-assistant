"use client";

import Link from "next/link";

export function HeroSection() {
  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Mesh gradient background */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `
            radial-gradient(ellipse 80% 50% at 50% -20%, rgba(120, 119, 198, 0.3), transparent),
            radial-gradient(ellipse 60% 80% at 100% 0%, rgba(255, 150, 100, 0.5), transparent),
            radial-gradient(ellipse 50% 60% at 100% 50%, rgba(255, 100, 150, 0.6), transparent),
            radial-gradient(ellipse 40% 50% at 70% 80%, rgba(255, 80, 180, 0.5), transparent),
            linear-gradient(180deg, #f8f6ff 0%, #ffffff 100%)
          `,
          zIndex: 0,
        }}
      />

      {/* Gradient swoosh overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: "60%",
          height: "100%",
          background: `
            linear-gradient(135deg, 
              rgba(167, 139, 250, 0.4) 0%,
              rgba(251, 146, 180, 0.5) 25%,
              rgba(251, 146, 180, 0.6) 50%,
              rgba(253, 186, 116, 0.5) 75%,
              rgba(253, 186, 116, 0.4) 100%
            )
          `,
          clipPath: "polygon(30% 0%, 100% 0%, 100% 100%, 0% 100%)",
          zIndex: 1,
        }}
      />

      {/* Content */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "2rem",
          maxWidth: "1200px",
          margin: "0 auto",
          width: "100%",
        }}
      >
        {/* Small stat text */}
        <p
          style={{
            fontSize: "0.875rem",
            color: "#635bff",
            fontWeight: 500,
            marginBottom: "1rem",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          Vellum is an AI assistant lab
        </p>

        {/* Main headline with gradient */}
        <h1
          style={{
            fontSize: "clamp(2.5rem, 6vw, 4rem)",
            fontWeight: 600,
            lineHeight: 1.1,
            marginBottom: "2rem",
            maxWidth: "600px",
            background: "linear-gradient(135deg, #0a2540 0%, #635bff 50%, #ff6b6b 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          A personal assistant that you can trust.
        </h1>

        {/* Subtitle */}
        <p
          style={{
            fontSize: "1.125rem",
            color: "#425466",
            lineHeight: 1.6,
            marginBottom: "2rem",
            maxWidth: "500px",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          An assistant with its own identity and context about your life. It clears your inbox, books flights, submits PRs, and stays yours forever.
        </p>

        {/* Buttons */}
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <Link
            href="/signup"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.875rem 1.5rem",
              backgroundColor: "#635bff",
              color: "#ffffff",
              borderRadius: "9999px",
              textDecoration: "none",
              fontSize: "1rem",
              fontWeight: 600,
              fontFamily: "system-ui, -apple-system, sans-serif",
              transition: "transform 0.15s ease, box-shadow 0.15s ease",
            }}
          >
            Get started
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 12L10 8L6 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
          
          <Link
            href="/login"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.875rem 1.5rem",
              backgroundColor: "transparent",
              color: "#0a2540",
              border: "1px solid #e0e0e0",
              borderRadius: "9999px",
              textDecoration: "none",
              fontSize: "1rem",
              fontWeight: 500,
              fontFamily: "system-ui, -apple-system, sans-serif",
              transition: "border-color 0.15s ease",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign up with Google
          </Link>
        </div>
      </div>
    </div>
  );
}
