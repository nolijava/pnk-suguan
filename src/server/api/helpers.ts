import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

export function fail(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } },
      { status: 422 },
    );
  }
  if (error instanceof AppError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  // Phase 9 — unexpected (non-AppError) failures must never leak internals
  // (SQL text, driver errors, paths) to the client. Full detail stays in the
  // SERVER-side log only; the response is a fixed generic message.
  console.error("[api] unhandled:", error);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "internal error" } },
    { status: 500 },
  );
}

export async function parseBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError("request body must be valid JSON", 400, "BAD_REQUEST");
  }
}
