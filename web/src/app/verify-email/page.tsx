"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

import { toast } from "@/components/app/core/Toast";

type VerifyStatus = "verifying" | "success" | "error";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<VerifyStatus>(() => {
    if (!token) {
      return "error";
    }
    return "verifying";
  });
  const verifiedRef = useRef<boolean>(false);

  const onVerifyResult = useEffectEvent(({ error }: { error: unknown }) => {
    if (error) {
      setStatus("error");
      toast.error("Verification failed. The link may be invalid or expired.");
    } else {
      setStatus("success");
      toast.success("Email verified! Redirecting...");
      setTimeout(() => {
        router.push("/assistant");
      }, 2000);
    }
  });

  useEffect(() => {
    if (!token || verifiedRef.current) {
      return;
    }
    verifiedRef.current = true;

    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((response) => {
        if (!response.ok) {
          return { error: true };
        }
        return { error: null };
      })
      .then(onVerifyResult);
  }, [token]);

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
              {status === "verifying" && (
                <>
                  <h1 className="mb-2 font-serif text-[2rem] font-bold italic text-white">
                    Verifying your email...
                  </h1>
                  <p className="text-sm text-zinc-400">
                    Please wait while we verify your email address.
                  </p>
                </>
              )}

              {status === "success" && (
                <>
                  <h1 className="mb-2 font-serif text-[2rem] font-bold italic text-white">
                    Email verified!
                  </h1>
                  <p className="text-sm text-zinc-400">
                    Your email has been verified. Redirecting you now...
                  </p>
                </>
              )}

              {status === "error" && (
                <>
                  <h1 className="mb-2 font-serif text-[2rem] font-bold italic text-white">
                    Verification failed
                  </h1>
                  <p className="text-sm text-zinc-400">
                    The verification link is invalid or has expired.
                  </p>
                  <div className="mt-6">
                    <Link
                      href="/login"
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white no-underline transition-colors hover:bg-indigo-700"
                    >
                      Back to sign in
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
