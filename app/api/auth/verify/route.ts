import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.json({ success: false, error: "token required" }, { status: 400 });
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const verify = await prisma.verificationToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() }
    }
  });

  if (!verify) {
    return NextResponse.json({ success: false, error: "token invalid or expired" }, { status: 404 });
  }

  await prisma.user.update({
    where: { id: verify.userId },
    data: {
      emailVerified: true,
      status: "active"
    }
  });

  await prisma.verificationToken.update({
    where: { id: verify.id },
    data: { usedAt: new Date() }
  });

  return NextResponse.json({
    success: true,
    message: "Email confirmed"
  });
}
