// ─────────────────────────────────────────────────────────────────────────────
// Bounded in-memory rate limiter
// No Redis, no DB, no external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

export const BODY_LIMIT = 65_536; // 64 KB

const HARD_CAP = 10_000;            // max active limiter keys across entire service
const CLEANUP_INTERVAL_MS = 5 * 60_000; // periodic sweep every 5 minutes

interface Entry {
  count: number;
  resetAt: number; // Unix ms when the window expires
  logged: boolean; // log-throttle flag: true = first block already logged
}

class BoundedRateLimiter {
  private store = new Map<string, Entry>();

  constructor() {
    const timer = setInterval(() => this.periodicCleanup(), CLEANUP_INTERVAL_MS);
    // Don't keep Node process alive just for this timer
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Check and increment counter for a key.
   * @returns allowed=true if request may proceed; firstBlock=true on the
   *          first blocked attempt (use for throttled logging).
   */
  check(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; retryAfterSeconds: number; firstBlock: boolean } {
    const now = Date.now();
    const entry = this.store.get(key);

    // New window (or entry expired)
    if (!entry || now >= entry.resetAt) {
      this.ensureCap(now);
      this.store.set(key, { count: 1, resetAt: now + windowMs, logged: false });
      return { allowed: true, retryAfterSeconds: 0, firstBlock: false };
    }

    // Within window, still under limit
    if (entry.count < limit) {
      entry.count++;
      return { allowed: true, retryAfterSeconds: 0, firstBlock: false };
    }

    // Blocked
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    const firstBlock = !entry.logged;
    if (firstBlock) entry.logged = true;
    return { allowed: false, retryAfterSeconds, firstBlock };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  private periodicCleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.resetAt) this.store.delete(key);
    }
  }

  /**
   * Called before inserting a new entry.
   * Step 1: evict expired entries.
   * Step 2: if still at cap, evict oldest 10% by insertion order.
   */
  private ensureCap(now: number) {
    if (this.store.size < HARD_CAP) return;

    for (const [key, entry] of this.store) {
      if (now >= entry.resetAt) this.store.delete(key);
      if (this.store.size < HARD_CAP) return;
    }

    // Still at cap — evict oldest by insertion order (Map preserves it)
    const evictCount = Math.ceil(this.store.size * 0.1);
    let evicted = 0;
    for (const key of this.store.keys()) {
      if (evicted >= evictCount) break;
      this.store.delete(key);
      evicted++;
    }
  }
}

// Singleton — shared across all route handlers in the same Node process
export const limiter = new BoundedRateLimiter();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the real client IP.
 * Priority: x-real-ip (set by Coolify/nginx as $remote_addr, not spoofable
 * by the client) → first value of x-forwarded-for → "unknown".
 */
export function getClientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return "unknown";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Russian plural for minutes: 1→минуту, 2-4→минуты, 5+→минут
function minuteWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "минуту";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "минуты";
  return "минут";
}

/**
 * 429 response — user-safe message, no internal details.
 * Includes Retry-After header.
 */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const word = minuteWord(minutes);
  return new Response(
    JSON.stringify({
      success: false,
      error: `Мы заботимся о безопасности пользователей, поэтому подключения временно ограничены. Попробуйте снова через ${minutes} ${word}.`,
      retry_after_seconds: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

/**
 * 413 response — body too large.
 */
export function bodyTooLargeResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "Размер запроса превышает допустимый.",
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json" },
    },
  );
}
