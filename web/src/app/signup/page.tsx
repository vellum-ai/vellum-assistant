"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { VellumHead } from "@/components/VellumHomepage";

export default function SignupPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const { signup } = useAuth();
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    const success = signup(username, password);
    if (success) {
      router.push("/assistant");
    } else {
      setError("Failed to create account");
    }
  };

  return (
    <>
      <VellumHead />
      <div
        className="section_home home"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          className="padding-global home z-index-2"
          style={{ width: "100%", maxWidth: "480px" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "2.5rem",
            }}
          >
            <Link href="/" aria-label="Back to home">
              <Image
                loading="lazy"
                src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6853f41167390a6658f3fd68_Vellum%20Wordmark%20Logo.svg"
                alt="Vellum"
                className="navbar2_logo"
                width={0}
                height={0}
                unoptimized
              />
            </Link>

            <div style={{ width: "100%" }}>
              <div
                className="text-align-center"
                style={{ marginBottom: "2rem" }}
              >
                <h1
                  className="heading-2-new font-playfair"
                  style={{ fontSize: "2rem", marginBottom: "0.5rem" }}
                >
                  <em>Create your account</em>
                </h1>
                <div
                  className="text-size-medium font-inter"
                  style={{ color: "#a1a1aa" }}
                >
                  {"Already have an account? "}
                  <Link
                    href="/login"
                    className="text-block-130"
                    style={{ textDecoration: "none" }}
                  >
                    Sign in
                  </Link>
                </div>
              </div>

              <form
                onSubmit={handleSubmit}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                }}
              >
                {error && (
                  <div
                    style={{
                      padding: "0.75rem 1rem",
                      borderRadius: "0.5rem",
                      backgroundColor: "rgba(239, 68, 68, 0.1)",
                      border: "1px solid rgba(239, 68, 68, 0.3)",
                      color: "#fca5a5",
                      fontSize: "0.875rem",
                    }}
                  >
                    {error}
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username"
                    className="font-inter"
                    style={{
                      width: "100%",
                      padding: "0.75rem 1rem",
                      borderRadius: "0.5rem",
                      border: "1px solid rgba(255, 255, 255, 0.1)",
                      backgroundColor: "rgba(255, 255, 255, 0.05)",
                      color: "#fff",
                      fontSize: "0.875rem",
                      outline: "none",
                    }}
                  />
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password (min 8 characters)"
                    className="font-inter"
                    style={{
                      width: "100%",
                      padding: "0.75rem 1rem",
                      borderRadius: "0.5rem",
                      border: "1px solid rgba(255, 255, 255, 0.1)",
                      backgroundColor: "rgba(255, 255, 255, 0.05)",
                      color: "#fff",
                      fontSize: "0.875rem",
                      outline: "none",
                    }}
                  />
                  <input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm password"
                    className="font-inter"
                    style={{
                      width: "100%",
                      padding: "0.75rem 1rem",
                      borderRadius: "0.5rem",
                      border: "1px solid rgba(255, 255, 255, 0.1)",
                      backgroundColor: "rgba(255, 255, 255, 0.05)",
                      color: "#fff",
                      fontSize: "0.875rem",
                      outline: "none",
                    }}
                  />
                </div>

                <button
                  type="submit"
                  className="d-button nav-button-5 cta-get-started new"
                  style={{
                    width: "100%",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0.5rem",
                    cursor: "pointer",
                    border: "none",
                    marginTop: "0.5rem",
                  }}
                >
                  <div className="btn-text nav-button-6 new">
                    Create account
                  </div>
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
                </button>
              </form>

              <div
                className="text-align-center"
                style={{ marginTop: "2rem" }}
              >
                <Link
                  href="/"
                  className="text-block-130 font-inter"
                  style={{ textDecoration: "none", fontSize: "0.875rem" }}
                >
                  &larr; Back to home
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
