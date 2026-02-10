"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { toast } from "@/components/shared/core/Toast";
import { VellumHead } from "@/components/marketing/VellumHomepage";

interface ForgotPasswordFormValues {
  email: string;
}

export default function ForgotPasswordPage() {
  const [error, setError] = useState("");
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<ForgotPasswordFormValues>();

  const onSubmit = async (data: ForgotPasswordFormValues) => {
    setError("");
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.email,
          redirectTo: "/login",
        }),
      });
      if (!response.ok) {
        const body = await response.json();
        setError(
          body.message ?? "Failed to send reset email. Please try again."
        );
        return;
      }
      toast.success(
        "If an account exists with that email, you will receive a password reset link. Please check your email."
      );
      router.push("/login");
    } catch {
      setError("Something went wrong. Please try again.");
    }
  };

  return (
    <>
      <VellumHead />
      <div className="section_home home min-h-screen flex items-center justify-center">
        <div className="padding-global home z-index-2 w-full max-w-[480px]">
          <div className="flex flex-col items-center gap-10">
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

            <div className="w-full">
              <div className="text-align-center mb-8">
                <h1 className="heading-2-new font-playfair text-[2rem] mb-2">
                  <em>Reset your password</em>
                </h1>
                <div className="text-size-medium font-inter text-[#a1a1aa]">
                  Enter your email to receive a reset link
                </div>
              </div>

              <form
                onSubmit={handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
              >
                {error && (
                  <div className="py-3 px-4 rounded-lg bg-red-500/10 border border-red-500/30 text-[#fca5a5] text-sm">
                    {error}
                  </div>
                )}
                <div className="flex flex-col gap-3">
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="Email"
                    className="font-inter w-full py-3 px-4 rounded-lg border border-white/10 bg-white/5 text-white text-sm outline-none"
                    {...register("email", { required: true })}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={`d-button nav-button-5 cta-get-started new w-full inline-flex items-center justify-center gap-2 border-none mt-2 ${isSubmitting ? "cursor-wait opacity-50" : "cursor-pointer"}`}
                >
                  <div className="btn-text nav-button-6 new">
                    {isSubmitting ? "Sending..." : "Send reset link"}
                  </div>
                  <div className="btn_arrow nav-button-7 w-5 h-5">
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

              <div className="text-align-center mt-8">
                <Link
                  href="/login"
                  className="text-block-130 font-inter no-underline text-sm"
                >
                  &larr; Back to sign in
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
