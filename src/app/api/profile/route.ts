import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";

export interface User {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/profile?username=xxx - Get user profile by username
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get("username");

    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    const sql = getDb();
    const result = await sql`
      SELECT id, username, email, display_name, profile_picture_url, created_at, updated_at
      FROM users
      WHERE username = ${username}
    `;

    if (result.length === 0) {
      // Auto-create user if doesn't exist (for prototype simplicity)
      const newUser = await sql`
        INSERT INTO users (username)
        VALUES (${username})
        RETURNING id, username, email, display_name, profile_picture_url, created_at, updated_at
      `;
      return NextResponse.json(newUser[0] as User);
    }

    return NextResponse.json(result[0] as User);
  } catch (error) {
    console.error("Error fetching profile:", error);
    return NextResponse.json(
      { error: "Failed to fetch profile" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/profile - Update user profile
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { username, display_name, email, profile_picture_url } = body;

    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    const sql = getDb();

    // Check if user exists, create if not
    const existing = await sql`SELECT id FROM users WHERE username = ${username}`;
    
    if (existing.length === 0) {
      const newUser = await sql`
        INSERT INTO users (username, display_name, email, profile_picture_url)
        VALUES (${username}, ${display_name || null}, ${email || null}, ${profile_picture_url || null})
        RETURNING id, username, email, display_name, profile_picture_url, created_at, updated_at
      `;
      return NextResponse.json(newUser[0] as User);
    }

    // Update existing user
    const result = await sql`
      UPDATE users
      SET 
        display_name = COALESCE(${display_name}, display_name),
        email = COALESCE(${email}, email),
        profile_picture_url = COALESCE(${profile_picture_url}, profile_picture_url),
        updated_at = NOW()
      WHERE username = ${username}
      RETURNING id, username, email, display_name, profile_picture_url, created_at, updated_at
    `;

    return NextResponse.json(result[0] as User);
  } catch (error) {
    console.error("Error updating profile:", error);
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }
}
