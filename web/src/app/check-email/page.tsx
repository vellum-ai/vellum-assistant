"use client";

import clsx from "clsx";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Controller, useForm } from "react-hook-form";

import { toast } from "@/components/app/core/Toast";

interface ResendFormValues {
  email: string;
}

function CheckEmailContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email");
  const reason = searchParams.get("reason");
  const isUnverifiedLogin = reason === "unverified";

  const { control, handleSubmit, formState: { isSubmitting, isSubmitSuccessful, isValid } } = useForm<ResendFormValues>({
    defaultValues: { email: email ?? "" },
    mode: "onChange",
  });

  const onSubmit = async (data: ResendFormValues) => {
    const response = await fetch("/api/auth/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: data.email, callbackURL: "/assistant" }),
    });
    if (!response.ok) {
      toast.error("Failed to resend verification email. Please try again.");
      throw new Error("Failed to send verification email");
    }
    toast.success("Verification email sent!");
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
                {isUnverifiedLogin ? "Verify your email" : "Check your email"}
              </h1>
              <p className="text-sm leading-relaxed text-zinc-400">
                {isUnverifiedLogin
                  ? "Your email address has not been verified yet. Please check your inbox and click the verification link to continue."
                  : (
                    <>
                      {"Account created successfully! We've sent a verification link to "}
                      {email ? (
                        <span className="font-medium text-white">{email}</span>
                      ) : (
                        "your email"
                      )}
                      {". Please check your inbox and click the link to verify your email address."}
                    </>
                  )}
              </p>
            </div>

            <div className="mb-6 rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-sm leading-normal text-zinc-400">
                {"Didn't receive the email? Check your spam folder or click below to resend."}
              </p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)}>
              {!email && (
                <Controller
                  name="email"
                  control={control}
                  rules={{
                    required: "Email is required",
                    pattern: {
                      value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                      message: "Invalid email address",
                    },
                  }}
                  render={({ field }) => (
                    <input
                      {...field}
                      type="email"
                      placeholder="Enter your email address"
                      className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                    />
                  )}
                />
              )}

              <button
                type="submit"
                disabled={!isValid || isSubmitting || isSubmitSuccessful}
                className={clsx(
                  "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700",
                  !isValid || isSubmitting || isSubmitSuccessful ? "cursor-default opacity-50" : "cursor-pointer"
                )}
              >
                {isSubmitSuccessful
                  ? "Verification email sent!"
                  : isSubmitting
                    ? "Sending..."
                    : "Resend verification email"}
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

export default function CheckEmailPage() {
  return (
    <Suspense>
      <CheckEmailContent />
    </Suspense>
  );
}
