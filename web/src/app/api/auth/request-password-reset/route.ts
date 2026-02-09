import { NextResponse } from "next/server";

import { auth } from "@/lib/auth/better-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, redirectTo } = body;

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const response = await auth.api.requestPasswordReset({
      body: { email, redirectTo },
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error requesting password reset:", error);
    return NextResponse.json(
      { error: "Failed to request password reset" },
      { status: 500 }
    );
  }
}
