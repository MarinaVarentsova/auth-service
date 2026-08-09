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
   * Every call counts (IP-style limits).
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

  /**
   * Read-only gate check — does NOT increment the counter.
   * Sets the logged flag on first block (throttled logging).
   * Used for failed-attempt limits where counting happens separately.
   */
  peekWithLog(
    key: string,
    limit: number,
  ): { blocked: boolean; retryAfterSeconds: number; firstBlock: boolean } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      return { blocked: false, retryAfterSeconds: 0, firstBlock: false };
    }
    if (entry.count < limit) {
      return { blocked: false, retryAfterSeconds: 0, firstBlock: false };
    }

    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    const firstBlock = !entry.logged;
    if (firstBlock) entry.logged = true;
    return { blocked: true, retryAfterSeconds, firstBlock };
  }

  /**
   * Increment a counter without making an allow/deny decision.
   * Creates a new window if none exists or the previous one expired.
   * Used for failed-attempt counting after the outcome is known.
   */
  increment(key: string, windowMs: number): void {
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || now >= entry.resetAt) {
      this.ensureCap(now);
      this.store.set(key, { count: 1, resetAt: now + windowMs, logged: false });
    } else {
      entry.count++;
    }
  }

  /**
   * Delete a counter entirely.
   * Used on successful login to clear the failed-attempt counter for that email.
   */
  reset(key: string): void {
    this.store.delete(key);
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
 * Extract the real client IP for a single trusted reverse-proxy hop
 * (Coolify/Traefik).
 *
 * How X-Forwarded-For works with one trusted proxy:
 *   Client sends request with optional X-Forwarded-For: <anything>
 *   Traefik APPENDS the real client IP it sees:
 *     X-Forwarded-For: <client-controlled-values>, <real-client-ip>
 *
 * The LAST element is added by the trusted proxy and cannot be spoofed
 * by the client — even if the client sends "X-Forwarded-For: fake-ip",
 * Traefik appends the real IP, making the header "fake-ip, real-ip".
 * We take the last element, ignoring all client-controlled prefixes.
 *
 * Falls back to "unknown" if the header is absent (e.g. direct connection
 * or proxy misconfiguration).
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",");
    return parts[parts.length - 1].trim();
  }
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
