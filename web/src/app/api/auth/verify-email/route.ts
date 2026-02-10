import { NextResponse } from "next/server";

import { auth } from "@/lib/auth/better-auth";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/verify-email?status=error", origin));
  }

  try {
    await auth.api.verifyEmail({
      query: { token },
    });
    return NextResponse.redirect(new URL("/verify-email?status=success", origin));
  } catch (error) {
    console.error("Error verifying email:", error);
    return NextResponse.redirect(new URL("/verify-email?status=error", origin));
  }
}
