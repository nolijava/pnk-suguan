import { z } from "zod";
import { requirePermission } from "@/server/auth/guard";
import { fail, parseQuery } from "@/server/api/helpers";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import {
  REPORT_PDF_IDS,
  MASTERLIST_FIELD_CODES,
  buildReportPdf,
  renderReportPdf,
  reportPdfFilename,
  type MasterlistFieldCode,
  type ReportPdfId,
} from "@/server/services/report-pdf.service";
import { REPORT_SOURCE_CODES, REPORT_TYPE_CODES } from "@/server/services/reports.service";

/**
 * New Update #5 — ONE PDF endpoint for every printable report.
 *
 * RBAC matches the report pages exactly (`reports.read`: ADMIN, SUPER_ADMIN,
 * SCHEDULER/ENCODER, VIEWER). The report id is an ALLOW-LIST — an unknown id is
 * a 404 and can never reach a builder. Every parameter is validated before the
 * service is called, and the response is `attachment` + `no-store`.
 *
 * Read-only: this route performs zero mutations and (like every other report
 * surface) writes no audit row — reports are not administrative actions.
 */
const querySchema = z
  .object({
    year: z.coerce.number().int().min(1900).max(2999).optional(),
    week: z.coerce.number().int().min(1).max(53).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    type: z.enum(REPORT_TYPE_CODES).optional(),
    source: z.enum(REPORT_SOURCE_CODES).optional(),
    teacherId: z.string().uuid().optional(),
    dakoId: z.string().uuid().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    language: z.enum(["FILIPINO", "ENGLISH"]).optional(),
    duty: z.enum(["DESTINADO", "KATUWANG"]).optional(),
    fields: z.string().max(400).optional(),
  })
  .strict();

/** `fields=a,b,c` → validated allow-list (an unknown code is rejected, never ignored). */
function parseFields(raw: string | undefined): MasterlistFieldCode[] | undefined {
  if (raw === undefined) return undefined;
  const codes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (codes.length === 0) throw new BadRequestError("fields must list at least one field");
  const allowed = MASTERLIST_FIELD_CODES as readonly string[];
  const unknown = codes.filter((c) => !allowed.includes(c));
  if (unknown.length > 0) {
    throw new BadRequestError(`unknown masterlist field(s): ${unknown.join(", ")}`);
  }
  return [...new Set(codes)] as MasterlistFieldCode[];
}

export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  try {
    await requirePermission("reports.read");
    const { report: rawReport } = await params;
    if (!(REPORT_PDF_IDS as readonly string[]).includes(rawReport)) {
      throw new NotFoundError(`unknown report: ${rawReport}`);
    }
    const report = rawReport as ReportPdfId;
    const q = parseQuery(req, querySchema);
    const current = isoWeek(new Date());

    // Per-report bounds that only the (year, week) pair can decide.
    if (q.week !== undefined) {
      const year = q.year ?? current.year;
      if (q.week > isoWeeksInYear(year)) {
        throw new BadRequestError(`week must be between 1 and ${isoWeeksInYear(year)} for ISO year ${year}`);
      }
    }
    // Field selection only exists for the masterlist; parseFields rejects an
    // unknown code instead of silently dropping it.
    const fields = parseFields(q.fields);

    const options = await buildReportPdf(report, {
      year: q.year,
      week: q.week,
      type: q.type,
      month: q.month,
      teacherId: q.teacherId,
      dakoId: q.dakoId,
      source: q.source,
      fields,
      status: q.status,
      language: q.language,
      duty: q.duty,
    });
    const buffer = await renderReportPdf(options);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${reportPdfFilename(options.filename)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
