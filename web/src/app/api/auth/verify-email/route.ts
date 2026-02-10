import { NextResponse } from "next/server";

import { auth } from "@/lib/auth/better-auth";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/verify-email?status=error", origin));
  }

  try {
    const verifyResponse = await auth.api.verifyEmail({
      query: { token },
      asResponse: true,
    });
    const redirect = NextResponse.redirect(new URL("/verify-email?status=success", origin));
    const setCookie = verifyResponse.headers.getSetCookie();
    for (const cookie of setCookie) {
      redirect.headers.append("Set-Cookie", cookie);
    }
    return redirect;
  } catch (error) {
    console.error("Error verifying email:", error);
    return NextResponse.redirect(new URL("/verify-email?status=error", origin));
  }
}
