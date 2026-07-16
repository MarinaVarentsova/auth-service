import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";
import { sendVerificationEmail } from "../../../../lib/unisender";

export async function POST(req: Request) {
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

    const exists = await prisma.user.findUnique({
      where: {
        projectId_email: {
          projectId: project.id,
          email,
        },
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

    const user = await prisma.user.create({
      data: {
        projectId: project.id,
        email,
        phone: phone || null,
        fullName: full_name,
        passwordHash,
        status: "pending_email",
        emailVerified: false,
        verificationTokens: {
          create: {
            projectId: project.id,
            tokenHash,
            expiresAt: new Date(
              Date.now() + 1000 * 60 * 60 * 24
            ),
          },
        },
      },
    });

    const authPublicUrl =
      process.env.AUTH_PUBLIC_URL ||
      new URL(req.url).origin;

    const verificationUrl =
      `${authPublicUrl}/api/auth/verify` +
      `?token=${encodeURIComponent(rawToken)}`;

    console.info("[EMAIL] verification start", {
      userId: user.id,
    });

    try {
      await sendVerificationEmail({
        to: email,
        verificationUrl,
      });

      console.info("[EMAIL] verification success", {
        userId: user.id,
      });
    } catch (emailError) {
      console.error("[EMAIL] verification error", {
        userId: user.id,
        message:
          emailError instanceof Error
            ? emailError.message
            : "Unknown email error",
      });

      return NextResponse.json(
        {
          success: false,
          error:
            "Пользователь создан, но письмо подтверждения не отправлено",
          user_id: user.id,
          project_id: project.id,
          status: user.status,
          email_verified: user.emailVerified,
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
