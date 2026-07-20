import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";
import { sendVerificationEmail } from "../../../../lib/unisender";

export async function POST(req: Request) {
  console.info("[AUTH-REGISTER] BUILD_MARKER_AUTH_SERVICE_V3");

  try {
    const { project_code, email, password, full_name, phone } =
      await req.json();

    if (!project_code || !email || !password || !full_name) {
      return NextResponse.json(
        {
          success: false,
          error:
            "project_code, email, password, full_name обязательны",
        },
        { status: 400 }
      );
    }

    const project = await prisma.project.findUnique({
      where: {
        code: project_code,
      },
    });

    if (!project || !project.isActive) {
      return NextResponse.json(
        {
          success: false,
          error: "Проект не найден или отключен",
        },
        { status: 404 }
      );
    }

    const exists = await prisma.user.findFirst({
      where: {
        projectId: project.id,
        email,
      },
    });

    if (exists) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Пользователь уже зарегистрирован в этом проекте",
        },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const rawToken = crypto.randomBytes(32).toString("hex");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    // Создаём пользователя отдельно от токена — чтобы знать точно,
    // что именно было создано в этом запросе при rollback.
    // DB-транзакция закрыта до HTTP-запроса к UniSender.
    const user = await prisma.user.create({
      data: {
        projectId: project.id,
        email,
        phone: phone || null,
        fullName: full_name,
        passwordHash,
        status: "pending_email",
        emailVerified: false,
      },
    });

    console.info("[AUTH-REGISTER] user created", { userId: user.id });

    const verificationToken = await prisma.verificationToken.create({
      data: {
        projectId: project.id,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    console.info("[AUTH-REGISTER] verification token created", {
      userId: user.id,
      tokenId: verificationToken.id,
    });

    const authPublicUrl =
      process.env.AUTH_PUBLIC_URL ||
      new URL(req.url).origin;

    // verificationUrl намеренно не логируется — содержит rawToken
    const verificationUrl =
      `${authPublicUrl}/api/auth/verify` +
      `?token=${encodeURIComponent(rawToken)}`;

    console.info("[EMAIL] verification request started", {
      userId: user.id,
    });

    try {
      await sendVerificationEmail({
        to: email,
        verificationUrl,
      });

      console.info("[EMAIL] verification accepted", {
        userId: user.id,
      });
    } catch (emailError) {
      console.error("[EMAIL] verification failed", {
        userId: user.id,
        message:
          emailError instanceof Error
            ? emailError.message
            : "Unknown email error",
      });

      // Компенсирующий откат: удаляем только записи, созданные в этом запросе
      try {
        await prisma.verificationToken.delete({
          where: { id: verificationToken.id },
        });
        await prisma.user.delete({
          where: { id: user.id },
        });
        console.info("[AUTH-REGISTER] rollback completed", {
          userId: user.id,
          tokenId: verificationToken.id,
        });
      } catch (rollbackError) {
        console.error("[AUTH-REGISTER] rollback failed", {
          userId: user.id,
          tokenId: verificationToken.id,
          message:
            rollbackError instanceof Error
              ? rollbackError.message
              : "Unknown rollback error",
        });
      }

      return NextResponse.json(
        {
          message:
            "Не удалось отправить письмо подтверждения. Попробуйте зарегистрироваться ещё раз.",
          buildMarker: "auth-service-v3",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      user_id: user.id,
      project_id: project.id,
      status: user.status,
      email_verified: user.emailVerified,

      // Временно оставляем для первичной проверки.
      // После успешного теста регистрации удалим.
      verification_token: rawToken,
    });
  } catch (error) {
    console.error("REGISTER_ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error: "Ошибка регистрации",
      },
      { status: 500 }
    );
  }
}
