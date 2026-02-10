"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";

import { useAuth } from "@/lib/auth";
import { toast } from "@/components/app/core/Toast";

interface SignupFormValues {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function SignupPage() {
  const { control, handleSubmit, getValues, formState: { isSubmitting, errors } } = useForm<SignupFormValues>({
    defaultValues: {
      username: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  });
  const { signup } = useAuth();
  const router = useRouter();

  const onSubmit = async (data: SignupFormValues) => {
    const errorMessage = await signup(data.username, data.email, data.password);
    if (!errorMessage) {
      toast.success("Account created! Check your email to verify.");
      router.push(`/check-email?email=${encodeURIComponent(data.email)}`);
    } else {
      toast.error(errorMessage);
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
                Create your account
              </h1>
              <p className="text-sm text-zinc-400">
                {"Already have an account? "}
                <Link
                  href="/login"
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Sign in
                </Link>
              </p>
            </div>

            <form
              method="post"
              onSubmit={handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-3">
                <div>
                  <Controller
                    name="username"
                    control={control}
                    rules={{ required: "Username is required" }}
                    render={({ field }) => (
                      <input
                        {...field}
                        id="username"
                        type="text"
                        autoComplete="username"
                        placeholder="Username"
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      />
                    )}
                  />
                  {errors.username && (
                    <p className="mt-1 text-xs text-red-300">{errors.username.message}</p>
                  )}
                </div>
                <div>
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
                        id="email"
                        type="email"
                        autoComplete="email"
                        placeholder="Email"
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      />
                    )}
                  />
                  {errors.email && (
                    <p className="mt-1 text-xs text-red-300">{errors.email.message}</p>
                  )}
                </div>
                <div>
                  <Controller
                    name="password"
                    control={control}
                    rules={{
                      required: "Password is required",
                      minLength: {
                        value: 8,
                        message: "Password must be at least 8 characters",
                      },
                    }}
                    render={({ field }) => (
                      <input
                        {...field}
                        id="password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Password (min 8 characters)"
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      />
                    )}
                  />
                  {errors.password && (
                    <p className="mt-1 text-xs text-red-300">{errors.password.message}</p>
                  )}
                </div>
                <div>
                  <Controller
                    name="confirmPassword"
                    control={control}
                    rules={{
                      required: "Please confirm your password",
                      validate: (value) =>
                        value === getValues("password") || "Passwords do not match",
                    }}
                    render={({ field }) => (
                      <input
                        {...field}
                        id="confirm-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Confirm password"
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      />
                    )}
                  />
                  {errors.confirmPassword && (
                    <p className="mt-1 text-xs text-red-300">{errors.confirmPassword.message}</p>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-50"
              >
                {isSubmitting ? "Creating account..." : "Create account"}
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
