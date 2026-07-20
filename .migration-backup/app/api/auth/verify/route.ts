import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";

export async function GET(req: Request) {
  const appUrl = process.env.APP_URL;

  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.json(
      { success: false, error: "token required" },
      { status: 400 }
    );
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const verify = await prisma.verificationToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
  });

  // Недействительный или просроченный токен
  if (!verify) {
    if (appUrl) {
      const url = new URL("/login", appUrl);
      url.searchParams.set("emailVerified", "0");
      url.searchParams.set("reason", "invalid_token");

      return NextResponse.redirect(url);
    }

    return NextResponse.json(
      {
        success: false,
        error: "token invalid or expired",
      },
      { status: 404 }
    );
  }

  await prisma.user.update({
    where: {
      id: verify.userId,
    },
    data: {
      emailVerified: true,
      status: "active",
    },
  });

  await prisma.verificationToken.update({
    where: {
      id: verify.id,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const user = await prisma.user.findUnique({
    where: {
      id: verify.userId,
    },
    select: {
      email: true,
    },
  });

  if (!user) {
    return NextResponse.json(
      {
        success: false,
        error: "User not found",
      },
      { status: 404 }
    );
  }

  if (!appUrl) {
    return NextResponse.json(
      {
        success: false,
        error: "APP_URL is not configured",
      },
      { status: 500 }
    );
  }

  const url = new URL("/login", appUrl);
  url.searchParams.set("emailVerified", "1");
  url.searchParams.set("email", user.email);

  return NextResponse.redirect(url);
}
