"use client";

import clsx from "clsx";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useOptimistic, useState } from "react";

import { toast } from "@/components/shared/core/Toast";
import { VellumHead } from "@/components/marketing/VellumHomepage";

type ResendStatus = "idle" | "sending" | "sent";

function CheckEmailContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email");
  const [resendStatus, setResendStatus] = useState<ResendStatus>("idle");
  const [optimisticStatus, setOptimisticStatus] = useOptimistic<ResendStatus>(resendStatus);

  const handleResend = async () => {
    if (!email || optimisticStatus !== "idle") {
      return;
    }
    setOptimisticStatus("sending");
    try {
      const response = await fetch("/api/auth/send-verification-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, callbackURL: "/assistant" }),
      });
      if (!response.ok) {
        throw new Error("Failed to send verification email");
      }
      setResendStatus("sent");
      toast.success("Verification email sent!");
    } catch {
      setResendStatus("idle");
      toast.error("Failed to resend verification email. Please try again.");
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
                  <em>Check your email</em>
                </h1>
                <div className="text-size-medium font-inter text-[#a1a1aa] leading-relaxed">
                  {"Account created successfully! We've sent a verification link to "}
                  {email ? (
                    <span className="text-white font-medium">{email}</span>
                  ) : (
                    "your email"
                  )}
                  {". Please check your inbox and click the link to verify your email address."}
                </div>
              </div>

              <div className="rounded-lg bg-white/5 border border-white/10 p-4 mb-6">
                <div className="font-inter text-[#a1a1aa] text-sm leading-normal">
                  {"Didn't receive the email? Check your spam folder or click below to resend."}
                </div>
              </div>

              {email && (
                <button
                  onClick={handleResend}
                  disabled={optimisticStatus !== "idle"}
                  className={clsx(
                    "d-button nav-button-5 cta-get-started new w-full inline-flex items-center justify-center gap-2 border-none",
                    optimisticStatus !== "idle" ? "cursor-default opacity-50" : "cursor-pointer"
                  )}
                >
                  <div className="btn-text nav-button-6 new">
                    {optimisticStatus === "sent"
                      ? "Verification email sent!"
                      : optimisticStatus === "sending"
                        ? "Sending..."
                        : "Resend verification email"}
                  </div>
                  <div className="d-button_bg-overlay nav-button-8"></div>
                </button>
              )}

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

export default function CheckEmailPage() {
  return (
    <Suspense>
      <CheckEmailContent />
    </Suspense>
  );
}
