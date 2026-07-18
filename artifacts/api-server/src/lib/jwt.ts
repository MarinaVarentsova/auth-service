import jwt from "jsonwebtoken";

const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "15m";
const REFRESH_EXPIRES = process.env.REFRESH_EXPIRES || "30d";

export function createAccessToken(payload: object): string {
  return jwt.sign(payload, SECRET, { expiresIn: JWT_EXPIRES } as jwt.SignOptions);
}

export function createRefreshToken(payload: object): string {
  return jwt.sign(payload, SECRET, { expiresIn: REFRESH_EXPIRES } as jwt.SignOptions);
}

export function verifyToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, SECRET) as jwt.JwtPayload;
}

/** Returns seconds until expiry based on JWT_EXPIRES string */
export function accessTokenExpiresIn(): number {
  const s = JWT_EXPIRES;
  if (s.endsWith("m")) return parseInt(s) * 60;
  if (s.endsWith("h")) return parseInt(s) * 3600;
  if (s.endsWith("d")) return parseInt(s) * 86400;
  return 900; // default 15m
}
