"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { toast } from "@/components/app/core/Toast";

interface ResetPasswordFormValues {
  newPassword: string;
  confirmPassword: string;
}

export default function ResetPasswordPage() {
  const [error, setError] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const tokenError = searchParams.get("error");
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<ResetPasswordFormValues>();

  const onSubmit = async (data: ResetPasswordFormValues) => {
    setError("");

    if (data.newPassword !== data.confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (data.newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          newPassword: data.newPassword,
        }),
      });
      if (!response.ok) {
        const body = await response.json();
        setError(
          body.message ?? "Failed to reset password. Please try again."
        );
        return;
      }
      toast.success("Your password has been reset. Please sign in.");
      router.push("/login");
    } catch {
      setError("Something went wrong. Please try again.");
    }
  };

  if (tokenError || !token) {
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
                  Invalid or expired link
                </h1>
                <p className="text-sm text-zinc-400">
                  This password reset link is invalid or has expired. Please
                  request a new one.
                </p>
              </div>

              <div className="mt-8 text-center">
                <Link
                  href="/forgot-password"
                  className="text-sm text-indigo-400 hover:text-indigo-300"
                >
                  Request a new reset link
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
                Set a new password
              </h1>
              <p className="text-sm text-zinc-400">
                Enter your new password below
              </p>
            </div>

            <form
              onSubmit={handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              )}
              <div className="flex flex-col gap-3">
                <Controller
                  name="newPassword"
                  control={control}
                  rules={{ required: true }}
                  render={({ field }) => (
                    <input
                      id="newPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password (min 8 characters)"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      {...field}
                    />
                  )}
                />
                <Controller
                  name="confirmPassword"
                  control={control}
                  rules={{ required: true }}
                  render={({ field }) => (
                    <input
                      id="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm new password"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      {...field}
                    />
                  )}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-50"
              >
                {isSubmitting ? "Resetting..." : "Reset password"}
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
                href="/login"
                className="text-sm text-zinc-400 hover:text-zinc-300"
              >
                &larr; Back to sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
