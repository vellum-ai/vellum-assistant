import { NextResponse } from "next/server";

import { auth } from "@/lib/auth/better-auth";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { error: "Token is required" },
        { status: 400 }
      );
    }

    const response = await auth.api.verifyEmail({
      query: {
        token,
      },
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error verifying email:", error);
    return NextResponse.json(
      { error: "Failed to verify email" },
      { status: 500 }
    );
  }
}
