import { requirePermission } from "@/server/auth/guard";
import { generateWeeklySuguanPdf } from "@/server/services/weekly-suguan-pdf.service";
import { getDb } from "@/server/db/client";
import { weeks } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import { fail, parseQuery } from "@/server/api/helpers";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { isoWeeksInYear } from "@/lib/iso-week";
import { weeklySuguanPdfQuerySchema } from "@/lib/validation/query-schemas";

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
    // A missing or malformed selection is the CALLER's error (400), not a
    // sanitized 500. `week` is additionally bounded by the ISO week count of
    // `year`, which only the pair can decide.
    const { year, week } = parseQuery(req, weeklySuguanPdfQuerySchema);
    if (week > isoWeeksInYear(year)) {
      throw new BadRequestError(`week must be between 1 and ${isoWeeksInYear(year)} for ISO year ${year}`);
    }

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
