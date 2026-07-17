import jwt from "jsonwebtoken";

const SECRET = process.env.AUTH_SECRET || "dev-secret";

export function createAccessToken(payload: any) {
  return jwt.sign(
    payload,
    SECRET as any,
    {
      expiresIn: (process.env.JWT_EXPIRES || "15m") as any,
    } as any
  );
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, SECRET as any);
}
