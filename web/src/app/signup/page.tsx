"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { useAuth } from "@/lib/auth";
import { VellumHead } from "@/components/VellumHomepage";

interface SignupFormValues {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function SignupPage() {
  const { register, handleSubmit, getValues, formState: { isSubmitting, errors } } = useForm<SignupFormValues>();
  const [serverError, setServerError] = useState<string>("");
  const { signup } = useAuth();
  const router = useRouter();

  const onSubmit = async (data: SignupFormValues) => {
    setServerError("");
    const errorMessage = await signup(data.username, data.email, data.password);
    if (!errorMessage) {
      router.push(`/check-email?email=${encodeURIComponent(data.email)}`);
    } else {
      setServerError(errorMessage);
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
                  <em>Create your account</em>
                </h1>
                <div className="text-size-medium font-inter text-[#a1a1aa]">
                  {"Already have an account? "}
                  <Link
                    href="/login"
                    className="text-block-130 no-underline"
                  >
                    Sign in
                  </Link>
                </div>
              </div>

              <form
                onSubmit={handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
              >
                {serverError && (
                  <div className="py-3 px-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                    {serverError}
                  </div>
                )}
                <div className="flex flex-col gap-3">
                  <div>
                    <input
                      id="username"
                      type="text"
                      autoComplete="username"
                      placeholder="Username"
                      className="font-inter w-full py-3 px-4 rounded-lg border border-white/10 bg-white/5 text-white text-sm outline-none"
                      {...register("username", { required: "Username is required" })}
                    />
                    {errors.username && (
                      <p className="text-red-300 text-xs mt-1">{errors.username.message}</p>
                    )}
                  </div>
                  <div>
                    <input
                      id="email"
                      type="email"
                      autoComplete="email"
                      placeholder="Email"
                      className="font-inter w-full py-3 px-4 rounded-lg border border-white/10 bg-white/5 text-white text-sm outline-none"
                      {...register("email", {
                        required: "Email is required",
                        pattern: {
                          value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                          message: "Invalid email address",
                        },
                      })}
                    />
                    {errors.email && (
                      <p className="text-red-300 text-xs mt-1">{errors.email.message}</p>
                    )}
                  </div>
                  <div>
                    <input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Password (min 8 characters)"
                      className="font-inter w-full py-3 px-4 rounded-lg border border-white/10 bg-white/5 text-white text-sm outline-none"
                      {...register("password", {
                        required: "Password is required",
                        minLength: {
                          value: 8,
                          message: "Password must be at least 8 characters",
                        },
                      })}
                    />
                    {errors.password && (
                      <p className="text-red-300 text-xs mt-1">{errors.password.message}</p>
                    )}
                  </div>
                  <div>
                    <input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm password"
                      className="font-inter w-full py-3 px-4 rounded-lg border border-white/10 bg-white/5 text-white text-sm outline-none"
                      {...register("confirmPassword", {
                        required: "Please confirm your password",
                        validate: (value) =>
                          value === getValues("password") || "Passwords do not match",
                      })}
                    />
                    {errors.confirmPassword && (
                      <p className="text-red-300 text-xs mt-1">{errors.confirmPassword.message}</p>
                    )}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={`d-button nav-button-5 cta-get-started new w-full inline-flex items-center justify-center gap-2 border-none mt-2 ${
                    isSubmitting ? "cursor-wait opacity-50" : "cursor-pointer"
                  }`}
                >
                  <div className="btn-text nav-button-6 new">
                    {isSubmitting ? "Creating account..." : "Create account"}
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
                  href="/"
                  className="text-block-130 font-inter no-underline text-sm"
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
