"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { VellumHead } from "@/components/VellumHomepage";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<"verifying" | "success" | "error">(() => {
    if (!token) {
      return "error";
    }
    return "verifying";
  });
  const verifiedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!token || verifiedRef.current) {
      return;
    }
    verifiedRef.current = true;

    authClient.verifyEmail({ query: { token } }).then(({ error }) => {
      if (error) {
        setStatus("error");
      } else {
        setStatus("success");
        setTimeout(() => {
          router.push("/assistant");
        }, 2000);
      }
    });
  }, [token, router]);

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
                {status === "verifying" && (
                  <>
                    <h1 className="heading-2-new font-playfair text-[2rem] mb-2">
                      <em>Verifying your email...</em>
                    </h1>
                    <div className="text-size-medium font-inter text-[#a1a1aa]">
                      Please wait while we verify your email address.
                    </div>
                  </>
                )}

                {status === "success" && (
                  <>
                    <h1 className="heading-2-new font-playfair text-[2rem] mb-2">
                      <em>Email verified!</em>
                    </h1>
                    <div className="text-size-medium font-inter text-[#a1a1aa]">
                      Your email has been verified. Redirecting you now...
                    </div>
                  </>
                )}

                {status === "error" && (
                  <>
                    <h1 className="heading-2-new font-playfair text-[2rem] mb-2">
                      <em>Verification failed</em>
                    </h1>
                    <div className="text-size-medium font-inter text-[#a1a1aa]">
                      The verification link is invalid or has expired.
                    </div>
                    <div className="mt-6">
                      <Link
                        href="/login"
                        className="d-button nav-button-5 cta-get-started new inline-flex items-center justify-center gap-2 border-none no-underline"
                      >
                        <div className="btn-text nav-button-6 new">
                          Back to sign in
                        </div>
                        <div className="d-button_bg-overlay nav-button-8"></div>
                      </Link>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
