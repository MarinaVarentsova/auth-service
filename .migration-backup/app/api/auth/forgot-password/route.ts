import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";
import { sendPasswordResetEmail } from "../../../../lib/unisender";

export async function POST(req: Request) {
  const { project_code, email: rawEmail } = await req.json();

  if (!project_code || !rawEmail) {
    return NextResponse.json(
      { success: false, error: "project_code и email обязательны" },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({
    where: { code: project_code },
  });

  if (!project || !project.isActive) {
    return NextResponse.json(
      { success: false, error: "Проект не найден или отключен" },
      { status: 404 }
    );
  }

  const email = rawEmail.trim().toLowerCase();

  // Всегда возвращаем 200 — не раскрываем, существует пользователь или нет
  const genericOk = NextResponse.json({
    success: true,
    message: "Если пользователь существует, письмо отправлено.",
  });

  const user = await prisma.user.findUnique({
    where: { projectId_email: { projectId: project.id, email } },
  });

  if (!user) {
    return genericOk;
  }

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    console.error("[AUTH-FORGOT] APP_URL is not configured");
    return NextResponse.json(
      { error: "Server misconfiguration: APP_URL is not set" },
      { status: 500 }
    );
  }

  // Инвалидируем все старые неиспользованные токены этого пользователя
  await prisma.passwordResetToken.updateMany({
    where: {
      userId: user.id,
      projectId: project.id,
      usedAt: null,
    },
    data: { usedAt: new Date() },
  });

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const resetToken = await prisma.passwordResetToken.create({
    data: {
      projectId: project.id,
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 час
    },
  });

  // rawToken намеренно не логируется
  console.info("[AUTH-FORGOT] reset token created", {
    userId: user.id,
    tokenId: resetToken.id,
  });

  const resetUrl = new URL("/reset-password", appUrl);
  resetUrl.searchParams.set("token", rawToken);
  resetUrl.searchParams.set("email", email);

  try {
    await sendPasswordResetEmail({ to: email, resetUrl: resetUrl.toString() });

    console.info("[AUTH-FORGOT] reset email sent", { userId: user.id });
  } catch (emailError) {
    console.error("[AUTH-FORGOT] email failed, deleting token", {
      userId: user.id,
      tokenId: resetToken.id,
      message:
        emailError instanceof Error ? emailError.message : "Unknown error",
    });

    await prisma.passwordResetToken.delete({ where: { id: resetToken.id } });

    return NextResponse.json(
      {
        success: false,
        error: "Не удалось отправить письмо. Попробуйте позже.",
      },
      { status: 502 }
    );
  }

  return genericOk;
}
