import { Router, type RequestHandler } from "express";
import { sessionVerificationPool } from "@workspace/db";
import { verifyToken } from "../lib/jwt";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxAuthorizationBytes = 4096;
export interface SessionSubject {
  id: string;
  projectId: string;
  emailVerified: boolean;
  status: string;
  projectActive: boolean;
}
export interface SessionDependencies {
  verify: typeof verifyToken;
  load: (
    userId: string,
    projectId: string,
  ) => Promise<SessionSubject | undefined>;
  secretConfigured: () => boolean;
}

// No writes, logging, cookies or client identity headers in this handler.
export function sessionHandler(deps: SessionDependencies): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const reject = (status: number) =>
      res.status(status).json({
        error:
          status === 503
            ? "Service unavailable"
            : status === 401
              ? "Unauthorized"
              : "Forbidden",
      });
    const authorization = req.headers.authorization;
    const count = req.rawHeaders.filter(
      (_, i) =>
        i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "authorization",
    ).length;
    if (
      count !== 1 ||
      typeof authorization !== "string" ||
      Buffer.byteLength(authorization, "utf8") > maxAuthorizationBytes
    ) {
      reject(401);
      return;
    }
    const bearer =
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        authorization,
      );
    if (!bearer) {
      reject(401);
      return;
    }
    // Existing login remains unchanged; this endpoint never accepts the development fallback.
    if (!deps.secretConfigured()) {
      reject(503);
      return;
    }
    let userId: string, projectId: string;
    try {
      const claims = deps.verify(bearer[1]);
      if (
        !claims ||
        typeof claims !== "object" ||
        typeof claims.sub !== "string" ||
        !uuid.test(claims.sub) ||
        typeof claims.projectId !== "string" ||
        !uuid.test(claims.projectId) ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Date.now() / 1000
      ) {
        reject(401);
        return;
      }
      userId = claims.sub;
      projectId = claims.projectId;
    } catch {
      reject(401);
      return;
    }
    try {
      const user = await deps.load(userId, projectId);
      if (
        !user ||
        user.id !== userId ||
        user.projectId !== projectId ||
        user.emailVerified !== true ||
        user.status !== "active" ||
        user.projectActive !== true
      ) {
        reject(403);
        return;
      }
      res.json({
        authenticated: true,
        user: { id: user.id, projectId: user.projectId, emailVerified: true },
      });
    } catch {
      reject(503);
    }
  };
}

async function loadSubject(
  userId: string,
  projectId: string,
): Promise<SessionSubject | undefined> {
  // Pool acquisition and SQL have finite timeouts. Transaction is read-only even if
  // a future edit accidentally attempts a write. Always release failed connections.
  const client = await sessionVerificationPool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    const result = await client.query<SessionSubject>(
      `SELECT u.id, u.project_id AS "projectId", u.email_verified AS "emailVerified", u.status, p.is_active AS "projectActive" FROM auth_users u JOIN auth_projects p ON p.id=u.project_id WHERE u.id=$1 AND u.project_id=$2`,
      [userId, projectId],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const router = Router();
router.get(
  "/auth/session",
  sessionHandler({
    verify: verifyToken,
    load: loadSubject,
    secretConfigured: () =>
      !!process.env.AUTH_SECRET &&
      process.env.AUTH_SECRET !== "dev-secret-change-me",
  }),
);
export default router;
