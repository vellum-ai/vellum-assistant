"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      const errorMessage = await login(username, password);
      if (!errorMessage) {
        router.push("/assistant");
      } else {
        setError(errorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0d0d0d]">
      <div className="w-full max-w-[480px] px-6">
        <div className="flex flex-col items-center gap-10">
          <Link href="/" aria-label="Back to home">
            <Image
              loading="lazy"
              src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6853f41167390a6658f3fd68_Vellum%20Wordmark%20Logo.svg"
              alt="Vellum"
              className="h-auto w-[120px]"
              width={120}
              height={30}
              unoptimized
            />
          </Link>

          <div className="w-full">
            <div className="mb-8 text-center">
              <h1 className="mb-2 font-serif text-[2rem] font-bold italic text-white">
                Sign in to Vellum
              </h1>
              <p className="text-sm text-zinc-400">
                {"Don't have an account? "}
                <Link
                  href="/signup"
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Sign up
                </Link>
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              )}
              <div className="flex flex-col gap-3">
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                />
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                />
              </div>

              <div className="text-right">
                <Link
                  href="/forgot-password"
                  className="text-[0.8125rem] text-zinc-400 hover:text-zinc-300"
                >
                  Forgot password?
                </Link>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-50"
              >
                {isSubmitting ? "Signing in..." : "Sign in"}
                <svg
                  width="20"
                  height="20"
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
              </button>
            </form>

            <div className="mt-8 text-center">
              <Link
                href="/"
                className="text-sm text-zinc-400 hover:text-zinc-300"
              >
                &larr; Back to home
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
