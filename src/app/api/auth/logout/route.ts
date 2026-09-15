import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logout } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { fail } from "@/server/api/helpers";

export async function POST() {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await logout(token);
    const res = NextResponse.json({ data: { ok: true } });
    res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    return fail(err);
  }
}
