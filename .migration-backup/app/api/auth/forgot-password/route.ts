import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";
import { sendPasswordResetEmail } from "../../../../lib/unisender";

export async function POST(req: Request) {
  let stage = "parse_body";

  try {
    const body = await req.json();
    const { project_code, email: rawEmail } = body;

    if (!project_code || !rawEmail) {
      return NextResponse.json(
        { success: false, error: "project_code и email обязательны" },
        { status: 400 }
      );
    }

    stage = "find_project";
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

    stage = "find_user";
    const user = await prisma.user.findFirst({
      where: { projectId: project.id, email },
    });

    if (!user) {
      return genericOk;
    }

    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      console.error("[AUTH-FORGOT] stage=check_app_url APP_URL is not configured");
      return NextResponse.json(
        { success: false, error: "Server misconfiguration: APP_URL is not set" },
        { status: 500 }
      );
    }

    // Инвалидируем все старые неиспользованные токены этого пользователя
    stage = "invalidate_old_tokens";
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

    stage = "create_reset_token";
    const resetToken = await prisma.passwordResetToken.create({
      data: {
        projectId: project.id,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 час
      },
    });

    console.info("[AUTH-FORGOT] reset token created", {
      userId: user.id,
      tokenId: resetToken.id,
    });

    stage = "build_reset_url";
    const resetUrl = new URL("/reset-password", appUrl);
    resetUrl.searchParams.set("token", rawToken);
    resetUrl.searchParams.set("email", email);

    stage = "send_email";
    try {
      await sendPasswordResetEmail({ to: email, resetUrl: resetUrl.toString() });
      console.info("[AUTH-FORGOT] reset email sent", { userId: user.id });
    } catch (emailError) {
      const message =
        emailError instanceof Error ? emailError.message : "Unknown error";

      console.error("[AUTH-FORGOT] stage=send_email email failed", {
        userId: user.id,
        tokenId: resetToken.id,
        message,
      });

      try {
        await prisma.passwordResetToken.delete({ where: { id: resetToken.id } });
      } catch (rollbackError) {
        console.error("[AUTH-FORGOT] stage=rollback_token rollback failed", {
          tokenId: resetToken.id,
          message:
            rollbackError instanceof Error
              ? rollbackError.message
              : "Unknown rollback error",
        });
      }

      return NextResponse.json(
        { success: false, error: "Не удалось отправить письмо. Попробуйте позже." },
        { status: 502 }
      );
    }

    return genericOk;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";

    console.error("[AUTH-FORGOT] unhandled error", { stage, message });

    return NextResponse.json(
      { success: false, error: "Внутренняя ошибка сервера" },
      { status: 500 }
    );
  }
}
