import pino from "pino";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import app from "../src/app";
import { pool, sessionVerificationPool } from "@workspace/db";
import { createAccessToken, verifyToken } from "../src/lib/jwt";
import { sessionHandler } from "../src/routes/session";
import { logger } from "../src/lib/logger";
const project = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const user = "00000000-0000-4000-8000-000000000101";
const secret = process.env.AUTH_SECRET!;
const token = (claims: object = { sub: user, projectId: project }) =>
  createAccessToken(claims);
const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

test("session HTTP + isolated PostgreSQL and legacy auth regression", async (t) => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(process.env.AUTH_LOCAL_TEST, "1");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/session_test");
  await pool.query(
    "INSERT INTO auth_projects(id,code,name) VALUES($1,'community-test','Synthetic project'),($2,'other-test','Other synthetic project')",
    [project, other],
  );
  await pool.query(
    "INSERT INTO auth_users(id,project_id,email,full_name,password_hash,status,email_verified) VALUES($1,$2,'fixture@example.invalid','Synthetic user',$3,'active',true)",
    [user, project, await bcrypt.hash("SyntheticPassword42!", 4)],
  );
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  async function session(access?: string, extra: Record<string, string> = {}) {
    return fetch(origin + "/api/auth/session", {
      headers: {
        ...(access ? { Authorization: "Bearer " + access } : {}),
        ...extra,
      },
    });
  }
  async function post(path: string, body: object) {
    return fetch(origin + "/api/auth/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  try {
    await t.test(
      "valid JWT returns minimal contract and makes no writes",
      async () => {
        const before = (
          await pool.query(
            "SELECT row_to_json(u) AS data FROM auth_users u WHERE id=$1",
            [user],
          )
        ).rows;
        const response = await session(token());
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
          authenticated: true,
          user: { id: user, projectId: project, emailVerified: true },
        });
        assert.deepEqual(
          (
            await pool.query(
              "SELECT row_to_json(u) AS data FROM auth_users u WHERE id=$1",
              [user],
            )
          ).rows,
          before,
        );
      },
    );
    await t.test(
      "missing/malformed bearer, cookie-only and forged identity headers rejected",
      async () => {
        for (const headers of [
          {},
          { cookie: "accessToken=" + token() },
          { Authorization: "Basic ignored" },
          {
            "x-user-id": user,
            "x-profile-id": user,
            "x-project-id": project,
            "x-role": "owner",
          },
          { Authorization: "Bearer " + "x".repeat(4097) },
        ])
          assert.equal(
            (await session(undefined, headers as Record<string, string>))
              .status,
            401,
          );
        const response = await session(token(), {
          "x-user-id": other,
          "x-profile-id": other,
          "x-project-id": other,
          "x-role": "owner",
        });
        assert.equal(response.status, 200);
        assert.equal(
          ((await response.json()) as { user: { id: string } }).user.id,
          user,
        );
      },
    );
    await t.test(
      "forged signature, expiry, missing expiry and invalid claims rejected",
      async () => {
        const bad = [
          jwt.sign({ sub: user, projectId: project }, "synthetic-wrong-key", {
            expiresIn: 60,
          }),
          jwt.sign({ sub: user, projectId: project }, secret, {
            expiresIn: -1,
          }),
          jwt.sign({ sub: user, projectId: project }, secret),
          token({ sub: "invalid", projectId: project }),
          token({ sub: user }),
          "not.a.token",
        ];
        for (const value of bad)
          assert.equal((await session(value)).status, 401);
      },
    );
    await t.test(
      "duplicate authorization and refresh credential rejected",
      async () => {
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            origin + "/api/auth/session",
            {
              headers: [
                "Host",
                new URL(origin).host,
                "Authorization",
                "Bearer " + token(),
                "Authorization",
                "Bearer " + token(),
              ],
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode!));
            },
          );
          req.on("error", reject);
          req.end();
        });
        assert.equal(status, 401);
        assert.equal(
          (await session(crypto.randomBytes(32).toString("hex"))).status,
          401,
        );
      },
    );
    await t.test("tampered project claim cannot verify signature", async () => {
      const parts = token().split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      payload.projectId = other;
      parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
      assert.equal((await session(parts.join("."))).status, 401);
    });
    await t.test(
      "signed foreign project and nonexistent user/project rejected",
      async () => {
        assert.equal(
          (await session(token({ sub: user, projectId: other }))).status,
          403,
        );
        assert.equal(
          (await session(token({ sub: other, projectId: project }))).status,
          403,
        );
        assert.equal(
          (
            await session(
              token({
                sub: user,
                projectId: "00000000-0000-4000-8000-000000000099",
              }),
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "email, user status and project status checked on every request",
      async () => {
        const access = token();
        await pool.query(
          "UPDATE auth_users SET email_verified=false WHERE id=$1",
          [user],
        );
        assert.equal((await session(access)).status, 403);
        await pool.query(
          "UPDATE auth_users SET email_verified=true,status='disabled' WHERE id=$1",
          [user],
        );
        assert.equal((await session(access)).status, 403);
        await pool.query("UPDATE auth_users SET status='active' WHERE id=$1", [
          user,
        ]);
        await pool.query(
          "UPDATE auth_projects SET is_active=false WHERE id=$1",
          [project],
        );
        assert.equal((await session(access)).status, 403);
        await pool.query(
          "UPDATE auth_projects SET is_active=true WHERE id=$1",
          [project],
        );
        assert.equal((await session(access)).status, 200);
      },
    );
    await t.test(
      "database lock timeout is bounded and connections recover",
      async () => {
        const lock = await pool.connect();
        try {
          await lock.query("BEGIN");
          await lock.query("LOCK TABLE auth_users IN ACCESS EXCLUSIVE MODE");
          const start = Date.now();
          assert.equal((await session(token())).status, 503);
          assert.ok(Date.now() - start < 6000);
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
        }
        assert.equal((await session(token())).status, 200);
      },
    );
    await t.test("database failure returns generic 503", async () => {
      await pool.query(
        "ALTER TABLE auth_users RENAME TO auth_users_unavailable",
      );
      try {
        const response = await session(token());
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: "Service unavailable",
        });
      } finally {
        await pool.query(
          "ALTER TABLE auth_users_unavailable RENAME TO auth_users",
        );
      }
    });
    await t.test(
      "production request logs contain no token, cookie, personal data or secret",
      async () => {
        const access = token(),
          chunks: string[] = [];
        const stream = (logger as any)[(pino as any).symbols.streamSym];
        const write = stream.write;
        stream.write = (chunk: string) => {
          chunks.push(String(chunk));
          return true;
        };
        try {
          await session(access, { Cookie: "session=synthetic-private-cookie" });
          await session("not.a.token");
          await new Promise((r) => setTimeout(r, 20));
        } finally {
          stream.write = write;
        }
        const logs = chunks.join("");
        assert.ok(logs.includes("/api/auth/session"));
        for (const value of [
          access,
          secret,
          "synthetic-private-cookie",
          "fixture@example.invalid",
          user,
          "not.a.token",
        ])
          assert.ok(!logs.includes(value));
      },
    );
    await t.test(
      "login/refresh/logout behavior and access token logout window preserved",
      async () => {
        assert.equal(
          (
            await post("login", {
              projectCode: "community-test",
              email: "fixture@example.invalid",
              password: "wrong",
            })
          ).status,
          401,
        );
        const login = await post("login", {
          projectCode: "community-test",
          email: "fixture@example.invalid",
          password: "SyntheticPassword42!",
        });
        assert.equal(login.status, 200);
        const first = (await login.json()) as {
          accessToken: string;
          refreshToken: string;
          expiresIn: number;
        };
        assert.equal(first.expiresIn, 900);
        assert.equal((await session(first.accessToken)).status, 200);
        const refreshed = await post("refresh", {
          refreshToken: first.refreshToken,
        });
        assert.equal(refreshed.status, 200);
        const second = (await refreshed.json()) as {
          accessToken: string;
          refreshToken: string;
          expiresIn: number;
        };
        assert.notEqual(first.refreshToken, second.refreshToken);
        assert.equal(
          (await post("refresh", { refreshToken: first.refreshToken })).status,
          401,
        );
        assert.equal(
          (await post("logout", { refreshToken: second.refreshToken })).status,
          200,
        );
        assert.equal(
          (await post("refresh", { refreshToken: second.refreshToken })).status,
          401,
        );
        assert.equal((await session(second.accessToken)).status, 200);
      },
    );
    await t.test(
      "verify-email behavior and login email restriction preserved",
      async () => {
        await pool.query(
          "UPDATE auth_users SET email_verified=false,status='pending_email' WHERE id=$1",
          [user],
        );
        assert.equal(
          (
            await post("login", {
              projectCode: "community-test",
              email: "fixture@example.invalid",
              password: "SyntheticPassword42!",
            })
          ).status,
          403,
        );
        const verification = crypto.randomBytes(32).toString("hex");
        await pool.query(
          "INSERT INTO auth_verification_tokens(project_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
          [project, user, hash(verification)],
        );
        const response = await fetch(
          origin + "/api/auth/verify-email?token=" + verification,
        );
        assert.equal(response.status, 200);
        assert.equal(
          (await fetch(origin + "/api/auth/verify-email?token=" + verification))
            .status,
          400,
        );
        assert.equal((await session(token())).status, 200);
      },
    );
    await t.test("missing production secret fails closed", async () => {
      const mini = express();
      mini.get(
        "/",
        sessionHandler({
          verify: verifyToken,
          load: async () => {
            throw Error("must not load");
          },
          secretConfigured: () => false,
        }),
      );
      const isolated = mini.listen(0, "127.0.0.1");
      await once(isolated, "listening");
      try {
        assert.equal(
          (
            await fetch(
              `http://127.0.0.1:${(isolated.address() as any).port}/`,
              { headers: { Authorization: "Bearer " + token() } },
            )
          ).status,
          503,
        );
      } finally {
        await new Promise<void>((resolve) => isolated.close(() => resolve()));
      }
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([pool.end(), sessionVerificationPool.end()]);
  }
});
