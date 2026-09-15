import { NextResponse } from "next/server";
import { loginSchema } from "@/lib/validation/schemas";
import { login } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { parseBody, fail } from "@/server/api/helpers";

export async function POST(req: Request) {
  try {
    const body = loginSchema.parse(await parseBody(req));
    const result = await login(body.email, body.password);
    const res = NextResponse.json({
      data: { userId: result.userId, mustChangePassword: result.mustChangePassword },
    });
    res.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: result.expiresAt,
    });
    return res;
  } catch (err) {
    return fail(err);
  }
}
