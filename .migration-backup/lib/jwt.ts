import jwt from "jsonwebtoken";

const SECRET = process.env.AUTH_SECRET;

export function createAccessToken(payload: any) {
  if (!SECRET) {
    console.error("[AUTH] AUTH_SECRET is missing");
    throw new Error("AUTH_SECRET_MISSING");
  }
  return jwt.sign(
    payload,
    SECRET as any,
    {
      expiresIn: (process.env.JWT_EXPIRES || "15m") as any,
    } as any
  );
}

export function verifyAccessToken(token: string) {
  if (!SECRET) {
    console.error("[AUTH] AUTH_SECRET is missing");
    throw new Error("AUTH_SECRET_MISSING");
  }
  return jwt.verify(token, SECRET as any);
}
