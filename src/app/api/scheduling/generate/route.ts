import { NextResponse } from "next/server";
import { requirePermission } from "@/server/auth/guard";

/** Placeholder (§43): automatic Suguan generation is NOT implemented in Phase 1. */
export async function POST() {
  try {
    await requirePermission("scheduling.generate");
    return NextResponse.json(
      {
        error: {
          code: "NOT_IMPLEMENTED",
          message: "Automatic Suguan generation ships in a later phase (spec §43).",
        },
      },
      { status: 501 },
    );
  } catch {
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }
}
