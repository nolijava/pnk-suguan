/**
 * New Update #4/#5 — report PDFs.
 *
 * Proves: every currently available report has a working PDF path through ONE
 * endpoint; the report id is an allow-list (an unknown one is 404, never a
 * builder); authorization matches the report pages (`reports.read`); the output
 * is a real PDF whose text layer carries the report's own data (the renderer is
 * uncompressed, like the release-docs renderer, so this is a real content check
 * rather than a size proxy); the Teacher Masterlist prints ONLY the selected
 * fields; read-only generation writes no audit row; and the accepted
 * Suguan/Patotoo services are untouched by these files.
 *
 * `requirePermission` reads the session through `next/headers`, which has no
 * request scope under vitest, so only `cookies()` is mocked and it is driven by
 * a variable — every case is a real HTTP-shaped call into the real handler.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { assignDestination } from "@/server/services/destination-history.service";
import { GET } from "@/app/api/reports/[report]/pdf/route";
import { readFileSync } from "node:fs";
import path from "node:path";

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token !== undefined && name === SESSION_COOKIE ? { name, value: auth.token } : undefined,
  }),
}));

const YEAR = 2087;

function get(report: string, query = ""): Promise<Response> {
  return GET(new Request(`http://localhost:3000/api/reports/${report}/pdf${query}`), {
    params: Promise.resolve({ report }),
  });
}

async function makeSession(role: "ADMIN" | "VIEWER" | "SCHEDULER"): Promise<string> {
  const inserted = await db
    .insert(schema.users)
    .values({
      email: `${role.toLowerCase()}-reportpdf@test.local`,
      fullName: `${role} Report Pdf`,
      passwordHash: "x",
    })
    .returning();
  const userId = inserted[0]!.id;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, role));
  await db.insert(schema.userRoles).values({ userId, roleId: roleRows[0]!.id });
  const { token } = await createSession(userId);
  return token;
}

/**
 * The PDF's text layer, decoded. The renderer writes uncompressed streams, and
 * PDFKit emits text as HEX strings inside `[...] TJ` arrays (splitting long runs
 * at kerning points), so the hex chunks are decoded and concatenated — a run
 * split across two chunks still reads as one continuous string, which is
 * exactly what makes this a real content check instead of a size proxy.
 */
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  let out = "";
  const re = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^)\\])*)\)/g;
  for (const m of raw.matchAll(re)) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) continue;
      out += Buffer.from(hex, "hex").toString("latin1");
    } else if (m[2] !== undefined) {
      out += m[2].replace(/\\([()\\])/g, "$1");
    }
  }
  return out;
}

let adminToken: string;
let viewerToken: string;
let teacherCode: string;

beforeAll(async () => {
  await resetTestDb();
  const adminId = await seedAdmin();
  adminToken = await makeSession("ADMIN");
  viewerToken = await makeSession("VIEWER");
  await makeSession("SCHEDULER");
  auth.token = adminToken;

  // Real data for the masterlist + history reports: one dako, one teacher with
  // a DESTINADO destination period and one assignment in a stored week.
  const dakoRow = (
    await db
      .insert(schema.dako)
      .values({
        dakoCode: "RP-1",
        name: "Dako Report",
        address: "Addr",
        dateEstablished: "2000-01-01",
        worshipDay: "SUNDAY",
        worshipTime: "09:00",
        language: "FILIPINO",
        status: "ACTIVE",
      })
      .returning()
  )[0]!;
  const teacherRow = (
    await db
      .insert(schema.teachers)
      .values({
        teacherCode: "PNK-G-7701",
        firstName: "Report",
        middleName: "Middle",
        lastName: "Teacher",
        suffix: "Jr.",
        birthday: "1990-05-04",
        purokGrupo: "Purok Report",
        dateOfOath: "2015-06-01",
        language: "FILIPINO",
        status: "ACTIVE",
      })
      .returning()
  )[0]!;
  teacherCode = teacherRow.teacherCode;
  await assignDestination(
    teacherRow.id,
    dakoRow.id,
    { userId: adminId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: ["ADMIN"], permissions: [] },
    { duty: "DESTINADO" },
  );
  const weekRow = (
    await db
      .insert(schema.weeks)
      .values({ year: YEAR, isoWeekNumber: 1, startDate: `${YEAR}-01-04`, endDate: `${YEAR}-01-10`, status: "DRAFT" })
      .returning()
  )[0]!;
  await db.insert(schema.assignments).values({
    weekId: weekRow.id,
    dakoId: dakoRow.id,
    teacherId: teacherRow.id,
    assignmentType: "SUGO",
    assignmentSource: "MANUAL",
    status: "ASSIGNED",
    assignedBy: adminId,
  });
});

afterEach(() => {
  auth.token = adminToken;
});

afterAll(async () => {
  auth.token = undefined;
  await teardown();
});

describe("GET /api/reports/:report/pdf — every report has a PDF path", () => {
  // Column heads are printed UPPERCASE; titles keep their authored casing.
  const CASES: Array<[string, string, string[]]> = [
    ["source-summary", `?year=${YEAR}`, ["Assignment source summary", "SOURCE", "Total assignments"]],
    ["annual", `?year=${YEAR}&type=SUGO`, ["Annual SUGO report", "Dako Report", "WEEK / YEAR"]],
    ["weekly", `?year=${YEAR}&week=1`, ["Weekly report", "Dako Report", "UNASSIGNED REASON"]],
    ["teacher", `?year=${YEAR}`, ["Teacher assignment history", "Dako Report", "W01 2087"]],
    ["dako", `?year=${YEAR}`, ["Dako assignment history", "Report Middle Teacher, Jr."]],
    ["celebrations", `?year=${YEAR}&month=5`, ["Celebrations", "Report Middle Teacher, Jr."]],
    ["teacher-masterlist", "", ["Teacher Masterlist", "PNK-G-7701"]],
  ];

  for (const [report, query, expected] of CASES) {
    it(`${report} → real PDF containing its own data`, async () => {
      const res = await get(report, query);
      expect(res.status, `${report} must render`).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const buffer = Buffer.from(await res.arrayBuffer());
      expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
      expect(buffer.length).toBeGreaterThan(1000);
      const text = pdfText(buffer);
      for (const needle of expected) {
        expect(text, `${report} PDF must contain "${needle}"`).toContain(needle);
      }
      // Footer carries the generation marker on every report.
      expect(text).toContain("generated");
    });
  }

  it("renders a valid PDF even when the selection has no data", async () => {
    const res = await get("weekly", `?year=2099&week=3`);
    expect(res.status).toBe(200);
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    const text = pdfText(buffer);
    expect(text).toContain("Week not started");
    expect(text).toContain("No slots for this section.");
  });
});

describe("GET /api/reports/:report/pdf — authorization and input validation", () => {
  it("rejects an anonymous caller with 401 before touching the report id", async () => {
    auth.token = undefined;
    for (const report of ["annual", "teacher-masterlist", "nonsense"]) {
      const res = await get(report, `?year=${YEAR}`);
      expect(res.status).toBe(401);
    }
  });

  it("rejects an unknown report id with 404 (the allow-list is the boundary)", async () => {
    for (const report of ["nonsense", "assignments", "AUDIT"]) {
      const res = await get(report, `?year=${YEAR}`);
      expect(res.status, `${report} must not resolve`).toBe(404);
    }
  });

  it("serves a VIEWER (reports.read) exactly like the report pages do", async () => {
    auth.token = viewerToken;
    expect((await get("annual", `?year=${YEAR}&type=SUGO`)).status).toBe(200);
    expect((await get("teacher-masterlist")).status).toBe(200);
  });

  it("rejects a malformed or unknown query value with a client error", async () => {
    for (const query of ["?year=abc", "?year=1800", "?type=WRONG", "?week=99", "?duty=PRESIDENT"]) {
      const res = await get("annual", `${query}&year=${query.includes("year") ? "" : YEAR}`);
      expect(res.status, `query ${query} must be a client error`).toBe(400);
    }
  });

  it("rejects an unknown masterlist field code instead of ignoring it", async () => {
    const res = await get("teacher-masterlist", "?fields=name,socialSecurityNumber");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("socialSecurityNumber");
  });
});

describe("Teacher Masterlist — only the selected fields are printed", () => {
  it("prints exactly the chosen columns", async () => {
    const res = await get("teacher-masterlist", "?fields=name,status");
    expect(res.status).toBe(200);
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    // Selected heads are present…
    expect(text).toContain("NAME");
    expect(text).toContain("STATUS");
    expect(text).toContain("Report Middle Teacher, Jr.");
    // …and NOT ONE unselected field head (or its row value).
    for (const absent of ["PUROK/GRUPO", "PANUNUMPA", "CURRENT DESTINATION", "TEACHER CODE", "REMARKS", "Purok Report"]) {
      expect(text, `unselected content must not be printed: ${absent}`).not.toContain(absent);
    }
  });

  it("includes Duty, Purok/Grupo and Teacher Code when they are selected", async () => {
    const res = await get("teacher-masterlist", "?fields=teacherCode,purokGrupo,duty");
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain("TEACHER CODE");
    expect(text).toContain("PUROK/GRUPO");
    expect(text).toContain("DUTY");
    expect(text).toContain(teacherCode);
    expect(text).toContain("Purok Report");
    expect(text).toContain("Destinado");
  });

  it("applies the status/duty filters to the exported rows", async () => {
    const res = await get("teacher-masterlist", "?fields=name,duty&duty=KATUWANG");
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain("No teachers match the selected filters.");
  });
});

describe("Report PDFs are read-only", () => {
  it("writes no audit row and mutates no scheduling data", async () => {
    const auditBefore = (await db.select().from(schema.auditLogs)).length;
    const assignmentsBefore = (await db.select().from(schema.assignments)).length;
    const destinationsBefore = (await db.select().from(schema.destinationHistory)).length;

    for (const [report, query] of [
      ["annual", `?year=${YEAR}&type=SUGO`],
      ["weekly", `?year=${YEAR}&week=1`],
      ["teacher-masterlist", ""],
      ["celebrations", `?year=${YEAR}&month=5`],
    ] as const) {
      expect((await get(report, query)).status).toBe(200);
    }

    expect((await db.select().from(schema.auditLogs)).length).toBe(auditBefore);
    expect((await db.select().from(schema.assignments)).length).toBe(assignmentsBefore);
    expect((await db.select().from(schema.destinationHistory)).length).toBe(destinationsBefore);
  });

  it("leaves the accepted Suguan/Patotoo PDF services untouched", () => {
    // The new renderer is a separate module: comment prose may NAME the approved
    // services (to explain the separation), but there must be no import edge in
    // either direction — their output stays frozen.
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const reportPdf = strip(
      readFileSync(path.resolve(__dirname, "../../src/server/services/report-pdf.service.ts"), "utf8"),
    );
    expect(reportPdf).not.toMatch(/from "[^"]*(weekly-suguan-pdf|suguan-slip-pdf)/);
    const suguan = strip(
      readFileSync(path.resolve(__dirname, "../../src/server/services/weekly-suguan-pdf.service.ts"), "utf8"),
    );
    expect(suguan).not.toContain("report-pdf.service");
  });
});
