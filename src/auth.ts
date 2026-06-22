import crypto from "crypto";
import path from "path";
import { promisify } from "util";
import type { Express, Request, Response, NextFunction } from "express";

/**
 * Local-only authentication for the Ring dashboard.
 *
 * Design goals:
 * - No external dependencies (uses Node's built-in `crypto` only).
 * - No network calls: nothing here talks to the internet or any IdP.
 * - Passwords are never stored in plaintext; scrypt with a per-user salt.
 * - Sessions are random high-entropy tokens kept server-side in memory,
 *   referenced by an HttpOnly; SameSite=Strict cookie. Sessions are lost
 *   on restart by design (re-login required), which is fine for a home lab.
 */

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE = "rd_session";
const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_MS =
  Number(process.env.AUTH_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

// Brute-force backoff (per client IP, in memory).
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

export type AuthConfig =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      username: string;
      passwordHash: string;
      secureCookie: boolean;
    };

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/** Produce a self-describing hash string: `scrypt$<saltHex>$<hashHex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time verification of a password against a stored hash. */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");

  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;

  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }

  if (expected.length === 0) {
    return false;
  }

  const derived = await scrypt(password, salt, expected.length);

  if (derived.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(derived, expected);
}

/** Constant-time string comparison that does not leak length via early exit. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const length = Math.max(bufA.length, bufB.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  // Still compare the real lengths so different-length strings never match.
  return crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export async function loadAuthConfig(): Promise<AuthConfig> {
  if (process.env.AUTH_ENABLED === "false") {
    return { enabled: false, reason: "AUTH_ENABLED=false" };
  }

  const username = process.env.AUTH_USERNAME?.trim();
  const passwordHashEnv = process.env.AUTH_PASSWORD_HASH?.trim();
  const passwordPlain = process.env.AUTH_PASSWORD;

  if (!username || (!passwordHashEnv && !passwordPlain)) {
    return {
      enabled: false,
      reason:
        "AUTH_USERNAME and AUTH_PASSWORD_HASH (or AUTH_PASSWORD) are not set",
    };
  }

  let passwordHash = passwordHashEnv ?? "";

  if (!passwordHash && passwordPlain) {
    passwordHash = await hashPassword(passwordPlain);
    console.warn(
      "[auth] AUTH_PASSWORD was provided in plaintext and hashed at startup. " +
        "Prefer AUTH_PASSWORD_HASH (generate one with `npm run auth:hash`)."
    );
  }

  const secureCookie = process.env.AUTH_COOKIE_SECURE === "true";

  return { enabled: true, username, passwordHash, secureCookie };
}

// ---------------------------------------------------------------------------
// Session store (in memory)
// ---------------------------------------------------------------------------

type Session = { username: string; expiresAt: number };

const sessions = new Map<string, Session>();

function createSession(username: string): string {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token: string | undefined): Session | null {
  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function destroySession(token: string | undefined) {
  if (token) {
    sessions.delete(token);
  }
}

// Periodically evict expired sessions so the map does not grow unbounded.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(token);
    }
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

// ---------------------------------------------------------------------------
// Cookie + request helpers
// ---------------------------------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};

  if (!header) {
    return out;
  }

  for (const part of header.split(";")) {
    const idx = part.indexOf("=");

    if (idx === -1) {
      continue;
    }

    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();

    if (key) {
      out[key] = decodeURIComponent(value);
    }
  }

  return out;
}

function buildSessionCookie(
  token: string,
  config: Extract<AuthConfig, { enabled: true }>,
  maxAgeMs: number
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];

  if (config.secureCookie) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildClearCookie(
  config: Extract<AuthConfig, { enabled: true }>
): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];

  if (config.secureCookie) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function wantsHtml(req: Request): boolean {
  return req.method === "GET" && req.accepts(["html", "json"]) === "html";
}

function clientKey(req: Request): string {
  // Local app: trust the socket address only, never X-Forwarded-For.
  return req.ip || req.socket.remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------
// Brute-force tracking
// ---------------------------------------------------------------------------

const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

function lockoutRemainingMs(key: string): number {
  const record = failedAttempts.get(key);

  if (!record) {
    return 0;
  }

  const remaining = record.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(key: string) {
  const record = failedAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  record.count += 1;

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_MS;
    record.count = 0;
  }

  failedAttempts.set(key, record);
}

function clearFailures(key: string) {
  failedAttempts.delete(key);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export type AuthHandles = {
  /** Middleware that gates protected routes. No-op when auth is disabled. */
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
};

/**
 * Registers the public (pre-auth) endpoints and returns the gate middleware.
 * Call this BEFORE registering protected routes/static, then apply
 * `requireAuth` and continue.
 */
export function installAuth(
  app: Express,
  config: AuthConfig,
  publicDir: string
): AuthHandles {
  const loginPage = path.join(publicDir, "login.html");
  const stylesheet = path.join(publicDir, "styles.css");

  // Auth status is always readable so the login page / UI can adapt.
  app.get("/api/auth/status", (req, res) => {
    if (!config.enabled) {
      res.json({ enabled: false, authenticated: true });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const session = getSession(cookies[SESSION_COOKIE]);

    res.json({
      enabled: true,
      authenticated: Boolean(session),
      username: session?.username ?? null,
    });
  });

  // Login page + the one stylesheet it needs are reachable without a session.
  app.get(["/login", "/login.html"], (_req, res) => {
    res.sendFile(loginPage);
  });

  app.get("/styles.css", (_req, res) => {
    res.sendFile(stylesheet);
  });

  if (!config.enabled) {
    console.warn(
      `[auth] Authentication is DISABLED (${config.reason}). ` +
        "The dashboard and its debug endpoints are open to anyone who can " +
        "reach this port. Set AUTH_USERNAME and AUTH_PASSWORD_HASH to enable login."
    );

    // Login/logout still respond sanely so the UI never breaks.
    app.post("/api/login", (_req, res) => {
      res.status(400).json({ ok: false, error: "Authentication is disabled" });
    });

    app.post("/api/logout", (_req, res) => {
      res.json({ ok: true });
    });

    return {
      requireAuth: (_req, _res, next) => next(),
    };
  }

  const enabledConfig = config;

  app.post("/api/login", async (req, res) => {
    const key = clientKey(req);
    const lockMs = lockoutRemainingMs(key);

    if (lockMs > 0) {
      res.status(429).json({
        ok: false,
        error: `Too many attempts. Try again in ${Math.ceil(
          lockMs / 1000
        )}s.`,
      });
      return;
    }

    const body = (req.body ?? {}) as {
      username?: unknown;
      password?: unknown;
    };

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Always run both checks (no early return) to avoid user enumeration.
    const userOk = timingSafeStringEqual(username, enabledConfig.username);
    const passOk = await verifyPassword(password, enabledConfig.passwordHash);

    if (!userOk || !passOk) {
      recordFailure(key);
      res.status(401).json({ ok: false, error: "Invalid credentials" });
      return;
    }

    clearFailures(key);
    const token = createSession(enabledConfig.username);

    res.setHeader(
      "Set-Cookie",
      buildSessionCookie(token, enabledConfig, SESSION_TTL_MS)
    );
    res.json({ ok: true, username: enabledConfig.username });
  });

  app.post("/api/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    destroySession(cookies[SESSION_COOKIE]);
    res.setHeader("Set-Cookie", buildClearCookie(enabledConfig));
    res.json({ ok: true });
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = getSession(token);

    if (session) {
      // Sliding expiration: extend the window on each authenticated request.
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      res.setHeader(
        "Set-Cookie",
        buildSessionCookie(token, enabledConfig, SESSION_TTL_MS)
      );
      (req as Request & { user?: string }).user = session.username;
      next();
      return;
    }

    if (wantsHtml(req)) {
      res.redirect("/login");
      return;
    }

    res.status(401).json({ ok: false, error: "Authentication required" });
  };

  return { requireAuth };
}
