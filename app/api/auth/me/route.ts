import { NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");

  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const token = auth.substring(7);
    const payload: any = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.user_id }
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        projectId: user.projectId,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        status: user.status,
        emailVerified: user.emailVerified
      }
    });

  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid token" },
      { status: 401 }
    );
  }
}
