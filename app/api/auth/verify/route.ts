import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  const appUrl = process.env.APP_URL?.replace(/\/$/, "");

  console.info("[AUTH-VERIFY] verification started");

  // APP_URL обязателен — без него некуда редиректить
  if (!appUrl) {
    console.error("[AUTH-VERIFY] APP_URL is not configured");
    return NextResponse.json(
      { error: "Server misconfiguration: APP_URL is not set" },
      { status: 500 }
    );
  }

  const failUrl = `${appUrl}/login?emailVerified=0&reason=invalid_token`;

  if (!token) {
    console.warn("[AUTH-VERIFY] verification failed — no token in request");
    return NextResponse.redirect(failUrl, { status: 302 });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  // Текущие правила проверки токена сохранены без изменений
  const verify = await prisma.verificationToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!verify) {
    console.warn("[AUTH-VERIFY] verification failed — token invalid or expired");
    return NextResponse.redirect(failUrl, { status: 302 });
  }

  console.info("[AUTH-VERIFY] token accepted", { userId: verify.userId });

  // Все DB-операции завершаются до redirect
  await prisma.user.update({
    where: { id: verify.userId },
    data: {
      emailVerified: true,
      status: "active",
    },
  });

  await prisma.verificationToken.update({
    where: { id: verify.id },
    data: { usedAt: new Date() },
  });

  console.info("[AUTH-VERIFY] user activated", { userId: verify.userId });

  const successUrl = `${appUrl}/login?emailVerified=1`;

  console.info("[AUTH-VERIFY] redirecting to login", {
    userId: verify.userId,
  });

  return NextResponse.redirect(successUrl, { status: 302 });
}
