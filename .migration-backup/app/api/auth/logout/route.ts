import { NextResponse } from "next/server";

// POST /api/auth/logout
//
// The auth service uses short-lived access tokens (15 min) with no
// server-side session store. Server-side invalidation is therefore not
// possible without a token blacklist or session table — neither of which
// exists in this project.
//
// Logout contract:
//   - Server returns 200 {success: true} to confirm the intent.
//   - Client is responsible for deleting the access token from its own
//     storage (localStorage, memory, etc.) on receipt of this response.
//   - The old access token may remain technically valid until its TTL
//     expires (15 min). This is the accepted architectural trade-off.
//   - No new token is issued; no session is created.

export async function POST() {
  return NextResponse.json({ success: true });
}
