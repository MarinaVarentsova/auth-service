import { createRequire } from "node:module";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
if (
  process.env.AUTH_LOCAL_TEST !== "1" ||
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1" ||
  new URL(process.env.DATABASE_URL).pathname !== "/session_test"
)
  throw Error(
    "Use scripts/test-auth-session.ps1 with an isolated local cluster",
  );
const root = fileURLToPath(new URL("../", import.meta.url));
const output = root + "dist-tests/session.test.cjs";
await mkdir(root + "dist-tests", { recursive: true });
await build({
  entryPoints: [root + "tests/session.test.ts"],
  outfile: output,
  platform: "node",
  format: "cjs",
  bundle: true,
  plugins: [
    {
      name: "external-packages",
      setup(b) {
        b.onResolve({ filter: /^[^./]|^@/ }, (args) => {
          if (
            !args.path.startsWith("@workspace/") &&
            !args.path.startsWith("node:") &&
            !args.path.startsWith("C:")
          )
            return {
              path: createRequire(args.resolveDir + "/package.json").resolve(
                args.path,
              ),
              external: true,
            };
        });
      },
    },
  ],
});
const result = spawnSync(process.execPath, ["--test", output], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    AUTH_SECRET: randomBytes(32).toString("hex"),
    JWT_EXPIRES: "15m",
    REFRESH_EXPIRES: "30d",
  },
});
process.exitCode = result.status ?? 1;
