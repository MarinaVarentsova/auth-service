import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

function signToken(payload: object) {
  const secret = process.env.AUTH_SECRET || "dev-secret";
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

export async function POST(req: Request) {
  try {
    const { project_code, email, password } = await req.json();

    if (!project_code || !email || !password) {
      return NextResponse.json(
        { success: false, error: "project_code, email, password обязательны" },
        { status: 400 }
      );
    }

    const project = await prisma.project.findUnique({
      where: { code: project_code }
    });

    if (!project || !project.isActive) {
      return NextResponse.json(
        { success: false, error: "Проект не найден или отключен" },
        { status: 404 }
      );
    }

    const user = await prisma.user.findUnique({
      where: {
        projectId_email: {
          projectId: project.id,
          email
        }
      }
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "Неверный email или пароль" },
        { status: 401 }
      );
    }

    if (!user.emailVerified || user.status !== "active") {
      return NextResponse.json(
        { success: false, error: "Email не подтвержден" },
        { status: 403 }
      );
    }

    const ok = await bcrypt.compare(password, user.passwordHash);

    if (!ok) {
      return NextResponse.json(
        { success: false, error: "Неверный email или пароль" },
        { status: 401 }
      );
    }

    const accessToken = signToken({
      user_id: user.id,
      project_id: project.id,
      project_code: project.code,
      email: user.email,
      status: user.status,
      exp: Math.floor(Date.now() / 1000) + 60 * 15
    });

    return NextResponse.json({
      success: true,
      access_token: accessToken,
      user: {
        id: user.id,
        project_id: project.id,
        project_code: project.code,
        email: user.email,
        full_name: user.fullName,
        phone: user.phone,
        status: user.status
      }
    });
  } catch (error) {
    console.error("LOGIN_ERROR", error);
    return NextResponse.json(
      { success: false, error: "Ошибка входа" },
      { status: 500 }
    );
  }
}
