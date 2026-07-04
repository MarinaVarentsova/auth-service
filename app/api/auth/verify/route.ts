import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.json({ success: false }, { status: 400 });
  }

  const verify = await prisma.verificationToken.findUnique({
    where: { token }
  });

  if (!verify) {
    return NextResponse.json({ success: false }, { status: 404 });
  }

  await prisma.user.update({
    where: { id: verify.userId },
    data: {
      emailVerified: true,
      status: "active"
    }
  });

  await prisma.verificationToken.delete({
    where: { token }
  });

  return NextResponse.redirect(
    `${process.env.APP_URL}/verified`
  );
}
