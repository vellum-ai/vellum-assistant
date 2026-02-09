import { NextResponse } from "next/server";

import { auth } from "@/lib/auth/better-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { newPassword, token } = body;

    if (!newPassword) {
      return NextResponse.json(
        { error: "New password is required" },
        { status: 400 }
      );
    }

    if (!token) {
      return NextResponse.json(
        { error: "Token is required" },
        { status: 400 }
      );
    }

    const response = await auth.api.resetPassword({
      body: { newPassword, token },
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error resetting password:", error);
    return NextResponse.json(
      { error: "Failed to reset password" },
      { status: 500 }
    );
  }
}
