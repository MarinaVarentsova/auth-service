import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  projectsTable,
  usersTable,
  verificationTokensTable,
  refreshTokensTable,
  passwordResetTokensTable,
} from "@workspace/db/schema";
import {
  RegisterBody,
  LoginBody,
  RefreshTokenBody,
  LogoutBody,
  VerifyEmailQueryParams,
  ForgotPasswordBody,
  ResetPasswordBody,
} from "@workspace/api-zod";
import {
  createAccessToken,
  createRefreshToken,
  verifyToken,
  accessTokenExpiresIn,
} from "../lib/jwt";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../lib/email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// POST /auth/register
router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectCode, email, password, fullName, phone } = parsed.data;

  // Find project
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.code, projectCode));

  if (!project || !project.isActive) {
    res.status(400).json({ error: "Project not found or inactive" });
    return;
  }

  // Check for existing user
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.projectId, project.id),
        eq(usersTable.email, email.toLowerCase())
      )
    );

  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Insert user — DB transaction is committed here, before the external HTTP call
  const [user] = await db
    .insert(usersTable)
    .values({
      projectId: project.id,
      email: email.toLowerCase(),
      phone: phone ?? null,
      fullName,
      passwordHash,
      status: "pending_email",
      emailVerified: false,
    })
    .returning();

  logger.info({ userId: user.id }, "[AUTH-REGISTER] user created");

  // Create verification token — no open DB transaction below this point
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  const [verificationToken] = await db
    .insert(verificationTokensTable)
    .values({
      projectId: project.id,
      userId: user.id,
      tokenHash,
      expiresAt,
    })
    .returning();

  logger.info(
    { userId: user.id, tokenId: verificationToken.id },
    "[AUTH-REGISTER] verification token created"
  );

  const authUrl = process.env.AUTH_URL || "http://localhost:3000";
  const verificationUrl = `${authUrl}/api/auth/verify-email?token=${rawToken}`;

  // Send email — outside any DB transaction
  try {
    await sendVerificationEmail({ to: user.email, verificationUrl });
    logger.info({ userId: user.id }, "[EMAIL] verification accepted");
  } catch (emailErr) {
    logger.error({ err: emailErr, userId: user.id }, "[EMAIL] verification failed");

    // Compensating rollback: delete only the records created in this request
    try {
      await db
        .delete(verificationTokensTable)
        .where(eq(verificationTokensTable.id, verificationToken.id));
      await db
        .delete(usersTable)
        .where(eq(usersTable.id, user.id));
      logger.info(
        { userId: user.id, tokenId: verificationToken.id },
        "[AUTH-REGISTER] rollback completed"
      );
    } catch (rollbackErr) {
      logger.error(
        { err: rollbackErr, userId: user.id, tokenId: verificationToken.id },
        "[AUTH-REGISTER] rollback failed"
      );
    }

    res.status(502).json({
      message:
        "Не удалось отправить письмо подтверждения. Попробуйте зарегистрироваться ещё раз.",
    });
    return;
  }

  res.status(201).json({ message: "Registration successful. Please verify your email." });
});

// POST /auth/login
router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectCode, email, password } = parsed.data;

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.code, projectCode));

  if (!project || !project.isActive) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.projectId, project.id),
        eq(usersTable.email, email.toLowerCase())
      )
    );

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ error: "Please verify your email before logging in" });
    return;
  }

  const payload = { sub: user.id, projectId: project.id, email: user.email };
  const accessToken = createAccessToken(payload);
  const rawRefresh = crypto.randomBytes(32).toString("hex");
  const refreshHash = hashToken(rawRefresh);

  const refreshExpires = process.env.REFRESH_EXPIRES || "30d";
  let refreshExpiresMs = 30 * 24 * 60 * 60 * 1000;
  if (refreshExpires.endsWith("d")) refreshExpiresMs = parseInt(refreshExpires) * 86400000;
  else if (refreshExpires.endsWith("h")) refreshExpiresMs = parseInt(refreshExpires) * 3600000;

  await db.insert(refreshTokensTable).values({
    projectId: project.id,
    userId: user.id,
    tokenHash: refreshHash,
    expiresAt: new Date(Date.now() + refreshExpiresMs),
  });

  res.json({
    accessToken,
    refreshToken: rawRefresh,
    expiresIn: accessTokenExpiresIn(),
  });
});

// POST /auth/refresh
router.post("/auth/refresh", async (req, res): Promise<void> => {
  const parsed = RefreshTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { refreshToken } = parsed.data;
  const tokenHash = hashToken(refreshToken);

  const [stored] = await db
    .select()
    .from(refreshTokensTable)
    .where(eq(refreshTokensTable.tokenHash, tokenHash));

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, stored.userId));

  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  // Rotate token — revoke old, issue new
  await db
    .update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokensTable.id, stored.id));

  const payload = { sub: user.id, projectId: stored.projectId, email: user.email };
  const accessToken = createAccessToken(payload);
  const rawRefresh = crypto.randomBytes(32).toString("hex");
  const refreshHash = hashToken(rawRefresh);

  await db.insert(refreshTokensTable).values({
    projectId: stored.projectId,
    userId: user.id,
    tokenHash: refreshHash,
    expiresAt: stored.expiresAt,
  });

  res.json({
    accessToken,
    refreshToken: rawRefresh,
    expiresIn: accessTokenExpiresIn(),
  });
});

// POST /auth/logout
router.post("/auth/logout", async (req, res): Promise<void> => {
  const parsed = LogoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const tokenHash = hashToken(parsed.data.refreshToken);

  await db
    .update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokensTable.tokenHash, tokenHash));

  res.json({ message: "Logged out" });
});

// GET /auth/verify-email
router.get("/auth/verify-email", async (req, res): Promise<void> => {
  const parsed = VerifyEmailQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  const tokenHash = hashToken(parsed.data.token);

  const [record] = await db
    .select()
    .from(verificationTokensTable)
    .where(eq(verificationTokensTable.tokenHash, tokenHash));

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    res.status(400).json({ error: "Invalid or expired verification token" });
    return;
  }

  await db
    .update(verificationTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(verificationTokensTable.id, record.id));

  await db
    .update(usersTable)
    .set({ emailVerified: true, status: "active" })
    .where(eq(usersTable.id, record.userId));

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    res.redirect(appUrl + "/verified");
    return;
  }

  res.json({ message: "Email verified successfully" });
});

// POST /auth/forgot-password
router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const parsed = ForgotPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectCode, email } = parsed.data;

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.code, projectCode));

  // Always return 200 to not leak user existence
  if (!project) {
    res.json({ message: "If the account exists, a reset email has been sent." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.projectId, project.id),
        eq(usersTable.email, email.toLowerCase())
      )
    );

  if (user) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await db.insert(passwordResetTokensTable).values({
      projectId: project.id,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const authUrl = process.env.AUTH_URL || "http://localhost:3000";
    const resetUrl = `${authUrl}/reset-password?token=${rawToken}`;

    try {
      await sendPasswordResetEmail({ to: user.email, resetUrl });
    } catch (err) {
      req.log.error({ err }, "Failed to send password reset email");
    }
  }

  res.json({ message: "If the account exists, a reset email has been sent." });
});

// POST /auth/reset-password
router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { token, password } = parsed.data;
  const tokenHash = hashToken(token);

  const [record] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, tokenHash));

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    res.status(400).json({ error: "Invalid or expired reset token" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, record.userId));

  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokensTable.id, record.id));

  // Revoke all refresh tokens for this user
  await db
    .update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokensTable.userId, record.userId),
        eq(refreshTokensTable.projectId, record.projectId)
      )
    );

  res.json({ message: "Password reset successfully" });
});

export default router;
