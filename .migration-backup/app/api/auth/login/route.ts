import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";
import {
  limiter,
  getClientIp,
  normalizeEmail,
  rateLimitResponse,
  bodyTooLargeResponse,
  BODY_LIMIT,
} from "../../../../lib/rateLimiter";

function signToken(payload: object) {
  // SECRET presence is validated before this function is called
  const secret = process.env.AUTH_SECRET as string;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

export async function POST(req: Request) {
  // ── 1. Body size guard (fast path — Content-Length header) ─────────────────
  const cl = req.headers.get("content-length");
  if (cl !== null && Number(cl) > BODY_LIMIT) return bodyTooLargeResponse();

  // ── 2. AUTH_SECRET guard ────────────────────────────────────────────────────
  if (!process.env.AUTH_SECRET) {
    console.error("[AUTH] AUTH_SECRET is missing");
    return NextResponse.json(
      { success: false, error: "Сервис временно недоступен. Мы уже работаем над исправлением." },
      { status: 503 }
    );
  }

  // ── 3. IP rate limit — checked BEFORE body parse ───────────────────────────
  const ip = getClientIp(req);
  const ipResult = limiter.check(`login:ip:${ip}`, 5, 10 * 60 * 1000);
  if (!ipResult.allowed) {
    if (ipResult.firstBlock) console.info("[AUTH_RATE_LIMIT] endpoint=login trigger=ip");
    return rateLimitResponse(ipResult.retryAfterSeconds);
  }

  // ── 4. Read and validate body (actual byte size, not just header) ──────────
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { success: false, error: "Ошибка чтения запроса." },
      { status: 400 }
    );
  }
  if (Buffer.byteLength(rawBody, "utf8") > BODY_LIMIT) return bodyTooLargeResponse();

  let parsed: { project_code?: unknown; email?: unknown; password?: unknown };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Некорректный формат запроса." },
      { status: 400 }
    );
  }

  const { project_code, email, password } = parsed;

  // ── 5. Failed-email gate — BEFORE bcrypt/DB ────────────────────────────────
  // Counts only wrong-password attempts; successful login resets the counter.
  // Protects against targeted password attacks on a known email without
  // locking out legitimate users who mistype once.
  const emailNorm = email && typeof email === "string" ? normalizeEmail(email) : null;
  const emailKey = emailNorm ? `login:failed-email:${emailNorm}` : null;

  if (emailKey) {
    const emailGate = limiter.peekWithLog(emailKey, 10);
    if (emailGate.blocked) {
      if (emailGate.firstBlock) console.info("[AUTH_RATE_LIMIT] endpoint=login trigger=failed-email");
      return rateLimitResponse(emailGate.retryAfterSeconds);
    }
  }

  // ── 6. Business logic (unchanged) ─────────────────────────────────────────
  try {
    if (!project_code || !email || !password) {
      return NextResponse.json(
        { success: false, error: "project_code, email, password обязательны" },
        { status: 400 }
      );
    }

    const project = await prisma.project.findUnique({
      where: { code: project_code as string }
    });

    if (!project || !project.isActive) {
      return NextResponse.json(
        { success: false, error: "Проект не найден или отключен" },
        { status: 404 }
      );
    }

    const user = await prisma.user.findFirst({
      where: {
        projectId: project.id,
        email: email as string,
      }
    });

    if (!user) {
      // User not found — same message as wrong password to avoid enumeration.
      // Counted as a failed attempt: protects against probing known emails.
      if (emailKey) limiter.increment(emailKey, 10 * 60 * 1000);
      return NextResponse.json(
        { success: false, error: "Неверный email или пароль" },
        { status: 401 }
      );
    }

    if (!user.emailVerified || user.status !== "active") {
      // Legitimate user — account not yet verified. Not counted as a failed
      // password attempt so the user is not locked out.
      return NextResponse.json(
        { success: false, error: "Email не подтверждён" },
        { status: 403 }
      );
    }

    const ok = await bcrypt.compare(password as string, user.passwordHash);

    if (!ok) {
      // Wrong password — increment failed-email counter.
      if (emailKey) limiter.increment(emailKey, 10 * 60 * 1000);
      return NextResponse.json(
        { success: false, error: "Неверный email или пароль" },
        { status: 401 }
      );
    }

    // ── Success: clear failed-email counter ───────────────────────────────────
    if (emailKey) limiter.reset(emailKey);

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
