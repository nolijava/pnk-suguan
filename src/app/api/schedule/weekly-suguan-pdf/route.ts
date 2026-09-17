import { requirePermission } from "@/server/auth/guard";
import { generateWeeklySuguanPdf } from "@/server/services/weekly-suguan-pdf.service";
import { getDb } from "@/server/db/client";
import { weeks } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import { fail } from "@/server/api/helpers";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isoWeeksInYear } from "@/lib/iso-week";

/**
 * Phase 7 — print-ready Weekly Suguan physical form (READ-ONLY).
 * RBAC: assignments.write → ADMIN + SCHEDULER/ENCODER only (Viewer 403,
 * anonymous 401). Accepts the established year+ISO-week selection; resolves
 * the existing weeks row (404 if the week has not been started); performs
 * ZERO data mutations.
 */
export async function GET(req: Request) {
  try {
    await requirePermission("assignments.write");
    const url = new URL(req.url);
    const year = Number(url.searchParams.get("year"));
    const week = Number(url.searchParams.get("week"));
    if (!Number.isInteger(year) || year < 1900 || year > 2999) throw new ValidationError("invalid year");
    if (!Number.isInteger(week) || week < 1 || week > isoWeeksInYear(year)) throw new ValidationError("invalid week");

    // Read-only resolution: look up the existing weeks row; never create one
    // (ensureWeek would INSERT — the PDF layer must not write).
    const weekRows = await getDb()
      .select({ id: weeks.id })
      .from(weeks)
      .where(and(eq(weeks.year, year), eq(weeks.isoWeekNumber, week)))
      .limit(1);
    const weekRow = weekRows[0];
    if (!weekRow) throw new NotFoundError("week not started for the selected year/week");

    const { buffer } = await generateWeeklySuguanPdf(weekRow.id);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="Suguan-W${week}-${year}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
