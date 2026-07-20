import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";

const INVALID_TOKEN_RESPONSE = NextResponse.json(
  {
    success: false,
    error: "Ссылка восстановления недействительна или срок её действия истёк.",
  },
  { status: 400 }
);

export async function POST(req: Request) {
  const { project_code, token, password, password_confirmation } =
    await req.json();

  if (!project_code || !token || !password || !password_confirmation) {
    return NextResponse.json(
      {
        success: false,
        error: "project_code, token, password и password_confirmation обязательны",
      },
      { status: 400 }
    );
  }

  if (password !== password_confirmation) {
    return NextResponse.json(
      { success: false, error: "Пароли не совпадают" },
      { status: 400 }
    );
  }

  // Минимум 8 символов, обязательно буква и цифра
  if (
    password.length < 8 ||
    !/[a-zA-Zа-яА-ЯёЁ]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Пароль должен быть не менее 8 символов и содержать букву и цифру",
      },
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

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const resetToken = await prisma.passwordResetToken.findFirst({
    where: {
      projectId: project.id,
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!resetToken) {
    return INVALID_TOKEN_RESPONSE;
  }

  const { user } = resetToken;

  // password намеренно не логируется
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  console.info("[AUTH-RESET] password changed, refresh tokens revoked", {
    userId: user.id,
  });

  return NextResponse.json({
    success: true,
    email: user.email,
    message: "Пароль успешно изменён.",
  });
}
