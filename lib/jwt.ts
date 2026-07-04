import jwt from "jsonwebtoken";

const SECRET = process.env.AUTH_SECRET!;

export function createAccessToken(payload: any) {
  return jwt.sign(payload, SECRET, {
    expiresIn: process.env.JWT_EXPIRES || "15m",
  });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, SECRET);
}
