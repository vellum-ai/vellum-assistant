"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";

import { useAuth } from "@/lib/auth";
import { toast } from "@/components/app/core/Toast";

interface LoginFormValues {
  username: string;
  password: string;
}

export default function LoginPage() {
  const { control, handleSubmit, formState: { isSubmitting, errors } } = useForm<LoginFormValues>();
  const { login } = useAuth();
  const router = useRouter();

  const onSubmit = async (data: LoginFormValues) => {
    const errorMessage = await login(data.username, data.password);
    if (!errorMessage) {
      router.push("/assistant");
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

            <form
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
                    name="password"
                    control={control}
                    rules={{ required: "Password is required" }}
                    render={({ field }) => (
                      <input
                        {...field}
                        id="password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="Password"
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-indigo-500/50"
                      />
                    )}
                  />
                  {errors.password && (
                    <p className="mt-1 text-xs text-red-300">{errors.password.message}</p>
                  )}
                </div>
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
