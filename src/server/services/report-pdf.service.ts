/**
 * New Update #4/#5 — REPORT PDFs (READ-ONLY output layer).
 *
 * ONE shared renderer for every printable report, deliberately separate from the
 * accepted Weekly Suguan / Patotoo services (`weekly-suguan-pdf.service.ts`,
 * `suguan-slip-pdf.service.ts`), which this module neither imports nor modifies.
 *
 * Contract:
 *   • Data comes from the EXISTING report services — the very functions the
 *     report pages call — so a PDF can never disagree with its page and no
 *     second query path is introduced.
 *   • Rendering is pure: no database access here, no mutations, no audit rows
 *     (read-only reporting is not audited anywhere in this application).
 *   • PDFKit core fonts only (no downloads, no assets), ISO timestamps, and a
 *     page footer with the report title, generation time and page number.
 *   • Column selection (Teacher Masterlist) is applied to the RENDERED table, so
 *     an unselected field can never leak into the file.
 */
import PDFDocument from "pdfkit";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { dako, destinationHistory, teachers } from "@/server/db/schema";
import { calculateAge } from "@/lib/anniversary";
import { formatFullName } from "@/lib/name";
import { dutyLabel } from "@/lib/duty";
import { isoWeek } from "@/lib/iso-week";
import {
  MASTERLIST_DEFAULT_FIELDS,
  MASTERLIST_FIELDS,
  type MasterlistFieldCode,
} from "@/lib/masterlist";
import {
  annualTypeReport,
  dakoAssignmentReport,
  sourceSummaryReport,
  teacherAssignmentReport,
  weeklyReport,
  type ReportTypeCode,
} from "./reports.service";
import { celebrationsReport } from "./celebration.service";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const REPORT_PDF_IDS = [
  "source-summary",
  "annual",
  "weekly",
  "teacher",
  "dako",
  "celebrations",
  "teacher-masterlist",
] as const;
export type ReportPdfId = (typeof REPORT_PDF_IDS)[number];

export interface PdfColumn {
  header: string;
  /** Relative width; the renderer scales the weights to the printable width. */
  weight: number;
  align?: "left" | "right";
}

export interface PdfSection {
  heading?: string;
  columns: PdfColumn[];
  rows: string[][];
  /** Rendered instead of the table when there are no rows. */
  emptyMessage?: string;
}

export interface ReportPdfOptions {
  title: string;
  subtitle?: string;
  /** Filter/meta lines under the title (deterministic, no secrets). */
  meta?: string[];
  sections: PdfSection[];
  footnote?: string;
  orientation?: "portrait" | "landscape";
  /** Output file stem, e.g. `Annual-SUGO-2026`. */
  filename: string;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const PALETTE = {
  navy: "#172033",
  slate: "#5F6878",
  blue: "#3B82F6",
  gold: "#C9A227",
  border: "#E4E2DC",
  head: "#EDF2FA",
  zebra: "#F7F6F2",
};

const MARGIN = 40;
const HEADER_BAND = 26;

/**
 * PDFKit core fonts use the standard WinAnsi set. Anything outside it is
 * transliterated (never silently dropped) — the same guard the release-docs
 * renderer uses, kept local so neither tool depends on the other.
 */
const SUBSTITUTIONS: Record<string, string> = {
  "\u2192": "->",
  "\u2265": ">=",
  "\u2264": "<=",
  "\u00d7": "x",
  "\u2248": "~",
  "\u2014": "-",
  "\u2013": "-",
  "\u2026": "...",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u00a0": " ",
  "\u00b7": "-",
};

export function pdfSafe(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  let out = String(value);
  for (const [from, to] of Object.entries(SUBSTITUTIONS)) {
    out = out.split(from).join(to);
  }
  return out;
}

/** Shared timestamp format for every report PDF (`YYYY-MM-DD HH:mm UTC`). */
export function pdfTimestamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function scaleWidths(columns: PdfColumn[], available: number): number[] {
  const total = columns.reduce((a, c) => a + c.weight, 0) || 1;
  return columns.map((c) => (c.weight / total) * available);
}

/**
 * Render one report PDF. Resolves with the complete buffer — the caller streams
 * it and never has to manage the document lifecycle.
 */
export async function renderReportPdf(opts: ReportPdfOptions): Promise<Buffer> {
  const orientation = opts.orientation ?? "portrait";
  const doc = new PDFDocument({
    size: "LETTER",
    layout: orientation,
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    // Uncompressed on purpose (same reasoning as the release-docs renderer): the
    // report stays small, its text layer is greppable for verification, and the
    // structure is trivially inspectable. The accepted Suguan/Patotoo PDFs keep
    // their own settings — this renderer is entirely separate.
    compress: false,
    info: { Title: opts.title, Author: "PNK Suguan System", Creator: "PNK Suguan System" },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - MARGIN * 2;
  const generatedAt = pdfTimestamp();

  const head = () => {
    doc.fillColor(PALETTE.gold).font("Helvetica-Bold").fontSize(8);
    doc.text("PNK SUGUAN SYSTEM", MARGIN, MARGIN, { width: contentWidth });
    doc.moveDown(0.2);
    doc.fillColor(PALETTE.navy).font("Helvetica-Bold").fontSize(16);
    doc.text(pdfSafe(opts.title), { width: contentWidth });
    if (opts.subtitle) {
      doc.fillColor(PALETTE.slate).font("Helvetica").fontSize(10);
      doc.text(pdfSafe(opts.subtitle), { width: contentWidth });
    }
    for (const line of opts.meta ?? []) {
      doc.fillColor(PALETTE.slate).font("Helvetica").fontSize(9);
      doc.text(pdfSafe(line), { width: contentWidth });
    }
    doc.moveDown(0.4);
  };

  head();

  const ensureRoom = (needed: number) => {
    if (doc.y + needed > pageHeight - MARGIN - 18) {
      doc.addPage();
      head();
    }
  };

  for (const section of opts.sections) {
    ensureRoom(60);
    if (section.heading) {
      doc.moveDown(0.3);
      doc.fillColor(PALETTE.navy).font("Helvetica-Bold").fontSize(11);
      doc.text(pdfSafe(section.heading), { width: contentWidth });
      doc.moveDown(0.2);
    }

    const widths = scaleWidths(section.columns, contentWidth);
    const rowHeight = 16;

    const drawHeader = () => {
      const y = doc.y;
      doc.rect(MARGIN, y, contentWidth, HEADER_BAND).fill(PALETTE.head);
      let x = MARGIN;
      doc.fillColor(PALETTE.navy).font("Helvetica-Bold").fontSize(8.5);
      section.columns.forEach((c, i) => {
        doc.text(pdfSafe(c.header).toUpperCase(), x + 4, y + 8, {
          width: widths[i]! - 8,
          align: c.align ?? "left",
          lineBreak: false,
        });
        x += widths[i]!;
      });
      doc.y = y + HEADER_BAND;
      doc.fillColor(PALETTE.navy);
    };

    if (section.rows.length === 0) {
      doc.fillColor(PALETTE.slate).font("Helvetica-Oblique").fontSize(9);
      doc.text(pdfSafe(section.emptyMessage ?? "No records for this selection."), { width: contentWidth });
      doc.moveDown(0.4);
      continue;
    }

    ensureRoom(HEADER_BAND + rowHeight);
    drawHeader();

    section.rows.forEach((row, index) => {
      if (doc.y + rowHeight > pageHeight - MARGIN - 18) {
        doc.addPage();
        head();
        drawHeader();
      }
      const y = doc.y;
      if (index % 2 === 1) doc.rect(MARGIN, y, contentWidth, rowHeight).fill(PALETTE.zebra);
      let x = MARGIN;
      doc.fillColor(PALETTE.navy).font("Helvetica").fontSize(8.5);
      section.columns.forEach((c, i) => {
        doc.text(pdfSafe(row[i] ?? ""), x + 4, y + 4, {
          width: widths[i]! - 8,
          align: c.align ?? "left",
          lineBreak: false,
          ellipsis: true,
        });
        x += widths[i]!;
      });
      doc
        .moveTo(MARGIN, y + rowHeight)
        .lineTo(MARGIN + contentWidth, y + rowHeight)
        .strokeColor(PALETTE.border)
        .lineWidth(0.5)
        .stroke();
      doc.y = y + rowHeight;
    });
    doc.moveDown(0.6);
  }

  if (opts.footnote) {
    ensureRoom(28);
    doc.fillColor(PALETTE.slate).font("Helvetica-Oblique").fontSize(8);
    doc.text(pdfSafe(opts.footnote), { width: contentWidth });
  }

  // Footer on every page (added after the body so the total is known).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = pageHeight - MARGIN + 8;
    doc.fillColor(PALETTE.slate).font("Helvetica").fontSize(7.5);
    doc.text(
      `${pdfSafe(opts.title)}  |  generated ${generatedAt}  |  page ${i + 1} of ${range.count}`,
      MARGIN,
      y,
      { width: contentWidth, align: "center", lineBreak: false },
    );
  }

  doc.end();
  return done;
}

/** Deterministic, filesystem-safe PDF filename for a report. */
export function reportPdfFilename(stem: string): string {
  const clean = pdfSafe(stem).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return `${clean || "report"}.pdf`;
}

// ---------------------------------------------------------------------------
// View builders — one per report, each reading the SAME service the page reads
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

function fmtDateTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? String(d) : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const ASSIGNMENT_COLUMNS: PdfColumn[] = [
  { header: "Week / Year", weight: 1.1 },
  { header: "Dako", weight: 2.2 },
  { header: "Type", weight: 1 },
  { header: "Teacher", weight: 2.4 },
  { header: "Status", weight: 0.9 },
  { header: "Source", weight: 1 },
  { header: "Assigned at", weight: 1.5 },
];

function assignmentRow(r: {
  weekNumber: number;
  year: number;
  dakoName: string;
  assignmentType: string;
  teacherName: string | null;
  status: string;
  assignmentSource: string;
  assignedAt: Date | string;
}): string[] {
  return [
    `W${String(r.weekNumber).padStart(2, "0")} ${r.year}`,
    r.dakoName,
    TYPE_LABEL[r.assignmentType] ?? r.assignmentType,
    r.teacherName ?? "—",
    r.status,
    r.assignmentSource,
    fmtDateTime(r.assignedAt),
  ];
}

/** Reports index — assignment source summary (source × type cross-tab). */
export async function buildSourceSummaryPdf(year: number): Promise<ReportPdfOptions> {
  const summary = await sourceSummaryReport(year);
  const sources = Object.keys(summary.bySource).sort();
  return {
    title: "Assignment source summary",
    subtitle: `ISO year ${year}`,
    meta: [`Total assignments: ${summary.total}`],
    filename: `Source-Summary-${year}`,
    sections: [
      {
        columns: [
          { header: "Source", weight: 1.6 },
          { header: "SUGO", weight: 1, align: "right" },
          { header: "RESERBA", weight: 1, align: "right" },
          { header: "RESERBA II", weight: 1.1, align: "right" },
          { header: "Total", weight: 1, align: "right" },
        ],
        rows: sources.map((s) => [
          s,
          String(summary.crossTab[s]?.SUGO ?? 0),
          String(summary.crossTab[s]?.RESERBA ?? 0),
          String(summary.crossTab[s]?.RESERBA_II ?? 0),
          String(summary.bySource[s] ?? 0),
        ]),
        emptyMessage: `No assignments recorded for ${year}.`,
      },
    ],
    footnote:
      "Counts every stored assignment row by source. HISTORICAL rows keep their recorded source — never remapped.",
    orientation: "portrait",
  };
}

/** Annual report for one assignment type. */
export async function buildAnnualPdf(year: number, type: ReportTypeCode): Promise<ReportPdfOptions> {
  const report = await annualTypeReport(year, type);
  const label = TYPE_LABEL[type] ?? type;
  const bySource = Object.entries(report.summary.bySource)
    .map(([s, n]) => `${s} ${n}`)
    .join(" · ");
  return {
    title: `Annual ${label} report`,
    subtitle: `ISO year ${report.year} · ${report.isoWeeks} ISO weeks`,
    meta: [
      `${report.summary.totalAssigned} assigned across ${report.summary.dakosCovered} dako(s) and ${report.summary.weeksCovered} week(s)`,
      bySource ? `By source — ${bySource}` : "No assignments yet",
    ],
    filename: `Annual-${type}-${report.year}`,
    sections: [{ columns: ASSIGNMENT_COLUMNS, rows: report.rows.map(assignmentRow) }],
    footnote: "Read-only report over stored assignments. Week numbers are ISO week numbers.",
    orientation: "landscape",
  };
}

/** Weekly report — the three SUGO/RESERBA/RESERBA II sections. */
export async function buildWeeklyPdf(year: number, week: number): Promise<ReportPdfOptions> {
  const report = await weeklyReport(year, week);
  const sections: PdfSection[] = report.sections.map((s) => ({
    heading: s.label,
    columns: [
      { header: "Dako", weight: 2.4 },
      { header: "Teacher", weight: 2.6 },
      { header: "Status", weight: 1 },
      { header: "Source", weight: 1 },
      { header: "Unassigned reason", weight: 2.4 },
    ],
    rows: s.slots.map((slot) => [
      slot.dakoName,
      slot.teacherName ?? "—",
      slot.teacherName ? (slot.status ?? "—") : "UNASSIGNED",
      slot.source ?? "—",
      slot.reasonCode ? `${slot.reasonCode}${slot.reason ? ` — ${slot.reason}` : ""}` : "—",
    ]),
    emptyMessage: "No slots for this section.",
  }));
  return {
    title: `Weekly report — W${String(week).padStart(2, "0")} ${year}`,
    subtitle: report.week
      ? `${report.week.startDate} to ${report.week.endDate} · week status ${report.week.status}`
      : "Week not started",
    meta: report.summary
      ? [`Assigned ${report.summary.assigned} · unassigned ${report.summary.unassigned}`]
      : undefined,
    filename: `Weekly-W${String(week).padStart(2, "0")}-${year}`,
    sections,
    footnote: report.note ?? "Read-only report. A planned suggestion is never presented as an assignment.",
    orientation: "portrait",
  };
}

/** Teacher assignment history. */
export async function buildTeacherHistoryPdf(opts: {
  teacherId?: string;
  year?: number;
  source?: string;
  type?: string;
}): Promise<ReportPdfOptions> {
  const report = await teacherAssignmentReport(opts);
  const meta = [
    `Year ${opts.year ?? "all"}`,
    `Source ${opts.source ?? "all"}`,
    `Type ${opts.type ? (TYPE_LABEL[opts.type] ?? opts.type) : "all"}`,
  ];
  return {
    title: "Teacher assignment history",
    subtitle: report.teacher ? `${report.teacher.name} (${report.teacher.code})` : "No teacher selected",
    meta: report.teacher
      ? [...meta, `${report.teacher.language} · ${report.teacher.status} · ${report.rows.length} row(s)`]
      : meta,
    filename: `Teacher-History-${report.teacher?.code ?? "all"}`,
    sections: [{ columns: ASSIGNMENT_COLUMNS, rows: report.rows.map(assignmentRow) }],
    footnote:
      "Internal administrative report. Teacher codes appear here only — never on the physical Weekly Suguan form.",
    orientation: "landscape",
  };
}

/** Dako assignment history. */
export async function buildDakoHistoryPdf(opts: {
  dakoId?: string;
  year?: number;
  source?: string;
  type?: string;
}): Promise<ReportPdfOptions> {
  const report = await dakoAssignmentReport(opts);
  return {
    title: "Dako assignment history",
    subtitle: report.dako ? `${report.dako.name} (${report.dako.code})` : "No dako selected",
    meta: [
      `Year ${opts.year ?? "all"}`,
      `Source ${opts.source ?? "all"}`,
      `Type ${opts.type ? (TYPE_LABEL[opts.type] ?? opts.type) : "all"}`,
      `${report.rows.length} row(s)`,
    ],
    filename: `Dako-History-${report.dako?.code ?? "all"}`,
    sections: [
      {
        columns: [
          { header: "Week / Year", weight: 1.1 },
          { header: "Type", weight: 1 },
          { header: "Teacher", weight: 2.4 },
          { header: "Status", weight: 0.9 },
          { header: "Source", weight: 1 },
          { header: "Assigned at", weight: 1.5 },
        ],
        rows: report.rows.map((r) => [
          `W${String(r.weekNumber).padStart(2, "0")} ${r.year}`,
          TYPE_LABEL[r.assignmentType] ?? r.assignmentType,
          r.teacherName ?? "—",
          r.status,
          r.assignmentSource,
          fmtDateTime(r.assignedAt),
        ]),
      },
    ],
    footnote: "Read-only report over stored assignments.",
    orientation: "portrait",
  };
}

/** Celebrations — birthdays and oath-anniversary groups for one month. */
export async function buildCelebrationsPdf(year: number, month: number): Promise<ReportPdfOptions> {
  const report = await celebrationsReport(year, month);
  const monthName = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][month - 1] ?? String(month);
  return {
    title: `Celebrations — ${monthName} ${year}`,
    subtitle: "Birthdays and oath anniversaries (dates and ages are derived, never stored)",
    meta: [
      `${report.birthdayCelebrants.length} birthday celebrant(s)`,
      `${report.anniversaryGroups.length} anniversary group(s)`,
    ],
    filename: `Celebrations-${year}-${String(month).padStart(2, "0")}`,
    sections: [
      {
        heading: "Birthdays",
        columns: [
          { header: "Date", weight: 1.2 },
          { header: "Teacher", weight: 3 },
          { header: "Code", weight: 1.2 },
          { header: "Birthday", weight: 1.2 },
          { header: "Turning", weight: 0.9, align: "right" },
        ],
        rows: report.birthdayCelebrants.map((c) => [
          `${String(c.day).padStart(2, "0")} ${monthName}`,
          c.teacherName,
          c.teacherCode,
          c.birthday,
          String(c.turningAge),
        ]),
        emptyMessage: "No birthdays recorded in this month.",
      },
      {
        heading: "Oath anniversaries (grouped by shared date)",
        columns: [
          { header: "Date", weight: 1.2 },
          { header: "Years completed", weight: 1.4 },
          { header: "Teachers", weight: 5 },
        ],
        rows: report.anniversaryGroups.map((g) => [
          g.date,
          g.completedYearsLabel,
          g.teachers.map((t) => `${t.teacherName} (${t.teacherCode})`).join("; "),
        ]),
        emptyMessage: "No oath anniversaries recorded in this month.",
      },
    ],
    orientation: "portrait",
  };
}

// ---------------------------------------------------------------------------
// Teacher Masterlist (New Update #4) — real fields, user-selected columns
// ---------------------------------------------------------------------------

/** The field catalogue lives in `@/lib/masterlist` (shared with the UI modal). */
export { MASTERLIST_FIELD_CODES, MASTERLIST_FIELDS, MASTERLIST_DEFAULT_FIELDS } from "@/lib/masterlist";
export type { MasterlistFieldCode } from "@/lib/masterlist";

export interface MasterlistRow {
  teacherCode: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  purokGrupo: string | null;
  birthday: string | null;
  age: number | null;
  dateOfOath: string | null;
  currentDestination: string | null;
  duty: string | null;
  language: string;
  status: string;
  dateInactive: string | null;
  inactiveReason: string | null;
  remarks: string | null;
}

/**
 * Masterlist rows — one read over the teacher master joined to the dako and the
 * OPEN destination period (the same relationship duty the teacher/dako pages
 * show). No field is invented and no scheduling table is touched.
 */
export async function teacherMasterlistRows(filters?: {
  status?: string;
  language?: string;
  duty?: string;
}): Promise<MasterlistRow[]> {
  const conds = [];
  if (filters?.status) conds.push(eq(teachers.status, filters.status));
  if (filters?.language) conds.push(eq(teachers.language, filters.language));
  const rows = await getDb()
    .select({
      teacherCode: teachers.teacherCode,
      firstName: teachers.firstName,
      middleName: teachers.middleName,
      lastName: teachers.lastName,
      suffix: teachers.suffix,
      purokGrupo: teachers.purokGrupo,
      birthday: teachers.birthday,
      dateOfOath: teachers.dateOfOath,
      language: teachers.language,
      status: teachers.status,
      dateInactive: teachers.dateInactive,
      inactiveReason: teachers.inactiveReason,
      remarks: teachers.remarks,
      currentDestination: dako.name,
      duty: destinationHistory.duty,
    })
    .from(teachers)
    .leftJoin(dako, eq(dako.id, teachers.currentDestinationId))
    .leftJoin(
      destinationHistory,
      and(eq(destinationHistory.teacherId, teachers.id), isNull(destinationHistory.endDate)),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(teachers.lastName), asc(teachers.firstName), asc(teachers.teacherCode));

  const mapped: MasterlistRow[] = rows.map((r) => ({
    ...r,
    age: r.birthday ? calculateAge(r.birthday) : null,
  }));
  return filters?.duty ? mapped.filter((r) => r.duty === filters.duty) : mapped;
}

/** The value of one selectable field for one row (never a made-up value). */
export function masterlistValue(row: MasterlistRow, field: MasterlistFieldCode): string {
  switch (field) {
    case "teacherCode":
      return row.teacherCode;
    case "name":
      return formatFullName(row);
    case "firstName":
      return row.firstName;
    case "middleName":
      return row.middleName ?? "—";
    case "lastName":
      return row.lastName;
    case "suffix":
      return row.suffix ?? "—";
    case "purokGrupo":
      return row.purokGrupo ?? "—";
    case "birthday":
      return row.birthday ?? "—";
    case "age":
      return row.age === null ? "—" : String(row.age);
    case "dateOfOath":
      return row.dateOfOath ?? "—";
    case "currentDestination":
      return row.currentDestination ?? "—";
    case "duty":
      return dutyLabel(row.duty);
    case "language":
      return row.language;
    case "status":
      return row.status;
    case "dateInactive":
      return row.dateInactive ?? "—";
    case "inactiveReason":
      return row.inactiveReason ?? "—";
    case "remarks":
      return row.remarks ?? "—";
    default:
      return "—";
  }
}

/** Teacher Masterlist PDF — ONLY the columns the caller selected. */
export async function buildTeacherMasterlistPdf(
  fields: MasterlistFieldCode[],
  filters?: { status?: string; language?: string; duty?: string },
): Promise<ReportPdfOptions> {
  const selected = fields.length ? fields : MASTERLIST_DEFAULT_FIELDS;
  const rows = await teacherMasterlistRows(filters);
  const meta = [
    `Fields: ${selected.map((f) => MASTERLIST_FIELDS[f].label).join(", ")}`,
    `Status ${filters?.status ?? "all"} · Language ${filters?.language ?? "all"} · Duty ${filters?.duty ? dutyLabel(filters.duty) : "all"}`,
    `${rows.length} teacher(s)`,
  ];
  return {
    title: "Teacher Masterlist",
    subtitle: "Master data as stored — nothing is computed except Age (from Birthday)",
    meta,
    filename: `Teacher-Masterlist-${pdfTimestamp().slice(0, 10)}`,
    sections: [
      {
        columns: selected.map((f) => ({
          header: MASTERLIST_FIELDS[f].label,
          weight: MASTERLIST_FIELDS[f].weight,
          align: f === "age" ? "right" : "left",
        })),
        rows: rows.map((row) => selected.map((f) => masterlistValue(row, f))),
        emptyMessage: "No teachers match the selected filters.",
      },
    ],
    footnote: `Age is derived from Birthday as of ${pdfTimestamp()} and is never stored. Only the selected fields are printed.`,
    orientation: selected.length > 9 ? "landscape" : "portrait",
  };
}

/** Dispatch used by the PDF route — one place that maps a report id to a build. */
export async function buildReportPdf(
  report: ReportPdfId,
  params: {
    year?: number;
    week?: number;
    type?: string;
    month?: number;
    teacherId?: string;
    dakoId?: string;
    source?: string;
    fields?: MasterlistFieldCode[];
    status?: string;
    language?: string;
    duty?: string;
  },
): Promise<ReportPdfOptions> {
  switch (report) {
    case "source-summary":
      return buildSourceSummaryPdf(params.year ?? new Date().getUTCFullYear());
    case "annual":
      return buildAnnualPdf(params.year ?? new Date().getUTCFullYear(), (params.type ?? "SUGO") as ReportTypeCode);
    case "weekly": {
      // Same defaults the Weekly report page uses: the CURRENT ISO week.
      const current = isoWeek(new Date());
      return buildWeeklyPdf(params.year ?? current.year, params.week ?? current.week);
    }
    case "teacher":
      return buildTeacherHistoryPdf({
        teacherId: params.teacherId,
        year: params.year,
        source: params.source,
        type: params.type,
      });
    case "dako":
      return buildDakoHistoryPdf({
        dakoId: params.dakoId,
        year: params.year,
        source: params.source,
        type: params.type,
      });
    case "celebrations":
      return buildCelebrationsPdf(
        params.year ?? new Date().getUTCFullYear(),
        params.month ?? new Date().getUTCMonth() + 1,
      );
    case "teacher-masterlist":
      return buildTeacherMasterlistPdf(params.fields ?? [], {
        status: params.status,
        language: params.language,
        duty: params.duty,
      });
  }
}
