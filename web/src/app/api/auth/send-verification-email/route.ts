import { NextResponse } from "next/server";

import { auth } from "@/lib/auth/better-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, callbackURL } = body;

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const response = await auth.api.sendVerificationEmail({
      body: {
        email,
        callbackURL: callbackURL ?? "/",
      },
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error sending verification email:", error);
    return NextResponse.json(
      { error: "Failed to send verification email" },
      { status: 500 }
    );
  }
}
