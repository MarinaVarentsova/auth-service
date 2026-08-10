import { NextResponse } from "next/server";

// POST /api/auth/refresh
//
// This service does not implement a refresh token mechanism.
// There is no refresh token generation, storage, rotation, or validation.
//
// Returning a controlled 401 instead of a fake success so that clients
// get an honest signal and fall back to the login flow — rather than
// believing a refresh succeeded when nothing actually happened.

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "Сессия истекла. Пожалуйста, войдите снова.",
    },
    { status: 401 },
  );
}
