import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// ── Security baseline ────────────────────────────────────────────────────────
// Remove the default "X-Powered-By: Express" fingerprint.
app.disable("x-powered-by");

// Minimal security headers for a JSON API backend.
// Notes:
//   - CSP omitted: pure JSON API, no HTML/browser document surface.
//   - HSTS omitted: TLS is terminated at the reverse proxy (Traefik/Coolify).
//   - Cross-Origin-Resource-Policy omitted: clients at platformaekspertov.ru
//     make cross-origin fetch requests; same-origin would block them.
app.use((_req: Request, res: Response, next: NextFunction) => {
  // Prevent MIME-type sniffing.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Disallow framing of any response (clickjacking protection).
  res.setHeader("X-Frame-Options", "DENY");
  // Send full origin only when navigating to the same origin, only origin otherwise.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Deny access to sensitive browser features.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Prevent this window from sharing a browsing context group with cross-origin openers.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});
// ────────────────────────────────────────────────────────────────────────────

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
