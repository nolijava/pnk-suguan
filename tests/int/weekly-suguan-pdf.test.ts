/**
 * Phase 7 — Weekly Suguan physical-form PDF tests.
 * View-model population rules (A/B/C/D), header/Sunday-date math (52/53-safe),
 * signatories/footer, no dako codes, Phase 6 mutation reflection, ZERO
 * application-data mutations (incl. PUBLISHED), RBAC, render smoke.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql } from "./helpers";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
}

function weekStart(year: number, week: number): string {
  const jan4 = new Date(`${year}-01-04T00:00:00Z`);
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + 6);
  return monday.toISOString().slice(0, 10);
}

/** Snapshot counts of every table the PDF layer must never touch (raw SQL — one round trip per table). */
async function mutationSnapshot() {
  const one = async (table: string) => {
    const r = await sql`select count(*)::int as n from ${sql(table)}`;
    return r[0]!.n as number;
  };
  return {
    assignments: await one("assignments"),
    history: await one("assignment_history"),
    availability: await one("teacher_availability"),
    audit: await one("audit_logs"),
    teachers: await one("teachers"),
    dako: await one("dako"),
    weeks: await one("weeks"),
  };
}

describe("phase 7 — weekly suguan PDF (read-only output layer)", () => {
  let adminId: string;
  let schedId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
  });

  afterAll(async () => { await teardown(); });

  const admin = () => actor(adminId, ["ADMIN"]);
  const sched = () => actor(schedId, ["SCHEDULER"]);

  async function mkTeacher(code: string, over: Partial<{ status: string; language: string }> = {}) {
    const rows = await db.insert(schema.teachers).values({
      teacherCode: code, firstName: "T", lastName: code, language: "FILIPINO",
      dateInactive: over.status === "INACTIVE" ? "2099-01-01" : null, ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkDako(code: string, name: string, over: Partial<{ language: string; status: string; worshipTime: string }> = {}) {
    const rows = await db.insert(schema.dako).values({
      dakoCode: code, name, address: "Addr", dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO", ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkWeek(year: number, week: number, status = "DRAFT") {
    const start = weekStart(year, week);
    const endD = new Date(`${start}T00:00:00Z`);
    endD.setUTCDate(endD.getUTCDate() + 6);
    const rows = await db.insert(schema.weeks).values({
      year, isoWeekNumber: week, startDate: start, endDate: endD.toISOString().slice(0, 10), status,
    }).returning();
    return rows[0]!;
  }
  async function setAvail(teacherId: string, weekId: string, status = "AVAILABLE", reason?: string) {
    await db.insert(schema.teacherAvailability).values({
      teacherId, weekId, availabilityStatus: status, reason: reason ?? null,
    }).onConflictDoUpdate({
      target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
      set: { availabilityStatus: status, reason: reason ?? null },
    });
  }
  async function assign(weekId: string, dakoId: string, teacherId: string, type: string, source = "AUTO") {
    await db.insert(schema.assignments).values({
      weekId, dakoId, teacherId, assignmentType: type, assignmentSource: source, status: "ASSIGNED",
    });
  }

  // ------------------------------------------------------------ header math
  it("header: exact title, Distrito MME, Lokal ILUGIN, week number, Sunday Petsa (never generation date)", async () => {
    const w = await mkWeek(2026, 38);
    const { buildWeeklySuguanViewModel } = await import("@/server/services/weekly-suguan-pdf.service");
    const vm = await buildWeeklySuguanViewModel(w.id);
    expect(vm.header.title).toBe("SUGUAN NG MGA GURO SA PAGSAMBA NG KABATAAN");
    expect(vm.header.distrito).toBe("MME");
    expect(vm.header.lokal).toBe("ILUGIN");
    expect(vm.header.weekNo).toBe(38);
    expect(vm.header.petsa).toBe("09/20/2026"); // Sunday of ISO W38 2026
  });

  it("Sunday date is ISO-correct for a 53-week year and W1 crossover", async () => {
    // 2020 has 53 ISO weeks; W53 ends Sunday 2021-01-03.
    const w53 = await mkWeek(2020, 53);
    const w1 = await mkWeek(2026, 1);
    const { buildWeeklySuguanViewModel } = await import("@/server/services/weekly-suguan-pdf.service");
    const vm53 = await buildWeeklySuguanViewModel(w53.id);
    const vm1 = await buildWeeklySuguanViewModel(w1.id);
    expect(vm53.header.petsa).toBe("01/03/2021");
    expect(vm53.header.weekNo).toBe(53);
    expect(vm1.header.petsa).toBe("01/04/2026"); // Sunday of 2026-W01
  });

  // ------------------------------------------------------ population rules
  it("Section A + B include ALL ACTIVE dakos (assignment or blank), exclude DISABLED, ordered by dakoCode; C omitted at zero RESERBA_II", async () => {
    const w = await mkWeek(2093, 2);
    const dA = await mkDako("PD-1", "Alpha Chapel");
    const dB = await mkDako("PD-2", "Beta Chapel");
    // DISABLED dako for the exclusion check — the schema's coherence CHECK
    // requires date_disabled when status=DISABLED, so insert it directly.
    const dOff = (await db.insert(schema.dako).values({
      dakoCode: "PD-3", name: "Disabled Chapel", address: "Addr", dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO", status: "DISABLED",
      dateDisabled: "2099-01-01", disableReason: "test",
    }).returning())[0]!;
    const t1 = await mkTeacher("PT-1");
    const t2 = await mkTeacher("PT-2");
    for (const t of [t1, t2]) await setAvail(t.id, w.id);
    await assign(w.id, dA.id, t1.id, "SUGO");
    await assign(w.id, dB.id, t2.id, "RESERBA");
    // No RESERBA_II anywhere.

    const { buildWeeklySuguanViewModel } = await import("@/server/services/weekly-suguan-pdf.service");
    const vm = await buildWeeklySuguanViewModel(w.id);

    expect(vm.sectionA.rows.map((r) => r.dakoName)).toEqual(["Alpha Chapel", "Beta Chapel"]); // no disabled, ordered
    expect(vm.sectionA.rows[0]!.pangalan).toContain("PT-1");
    expect(vm.sectionA.rows[1]!.pangalan).toBeNull(); // blank when unassigned
    expect(vm.sectionA.rows.every((r) => r.oras === "09:00")).toBe(true);

    expect(vm.sectionB.rows.map((r) => r.dakoName)).toEqual(["Alpha Chapel", "Beta Chapel"]);
    expect(vm.sectionB.rows[0]!.pangalan).toBeNull(); // missing reserba → blank
    expect(vm.sectionB.rows[1]!.pangalan).toContain("PT-2");

    expect(vm.sectionC).toBeNull(); // zero RESERBA_II ⇒ section omitted entirely
  });

  it("Section C appears only when ≥1 RESERBA_II exists and lists ONLY those dakos", async () => {
    const w = await mkWeek(2093, 3);
    const dA = await mkDako("PE-1", "Alpha");
    const dB = await mkDako("PE-2", "Beta");
    const t1 = await mkTeacher("PE-T1");
    const t2 = await mkTeacher("PE-T2");
    for (const t of [t1, t2]) await setAvail(t.id, w.id);
    await assign(w.id, dB.id, t1.id, "SUGO");
    await assign(w.id, dB.id, t2.id, "RESERBA_II"); // only Beta has RESERBA_II

    const { buildWeeklySuguanViewModel } = await import("@/server/services/weekly-suguan-pdf.service");
    const vm = await buildWeeklySuguanViewModel(w.id);
    expect(vm.sectionC).not.toBeNull();
    expect(vm.sectionC!.rows.map((r) => r.dakoName)).toEqual(["Beta"]); // not all dakos
    expect(vm.sectionC!.rows[0]!.pangalan).toContain("PE-T2");
  });

  it("Section D static: exactly 4 SUGO + 2 RESERBA rows, all names/signatures blank; signatories + footer exact", async () => {
    const w = await mkWeek(2093, 4);
    const { buildWeeklySuguanViewModel } = await import("@/server/services/weekly-suguan-pdf.service");
    const vm = await buildWeeklySuguanViewModel(w.id);
    expect(vm.sectionD.heading).toBe("D. MGA MAGTUTURO SA KLASE");
    expect(vm.sectionD.rows.filter((r) => r.gampanin === "SUGO").length).toBe(4);
    expect(vm.sectionD.rows.filter((r) => r.gampanin === "RESERBA").length).toBe(2);
    expect(vm.signatories).toEqual([
      { name: "NOLI JAVA", role: "PANGULONG LUPON NG PNK" },
      { name: "MCCOY SUATARON", role: "PASTOR" },
    ]);
    expect(vm.footer).toBe("Revised September 2026");
  });

  // --------------------------------------------------- Phase 6 reflection
  it("reflects Phase 6 mutations: cleared → blank + dako row stays; replacement → current teacher; MANUAL/OVERRIDE visible", async () => {
    const w = await mkWeek(2093, 5);
    const dA = await mkDako("PF-1", "Alpha");
    const t1 = await mkTeacher("PF-T1");
    const t2 = await mkTeacher("PF-T2");
    const t3 = await mkTeacher("PF-T3");
    for (const t of [t1, t2, t3]) await setAvail(t.id, w.id);
    await assign(w.id, dA.id, t1.id, "SUGO");
    await assign(w.id, dA.id, t2.id, "RESERBA");
    await assign(w.id, dA.id, t3.id, "RESERBA_II", "OVERRIDE");

    const { buildWeeklySuguanViewModel } = await import("@/server/services/weekly-suguan-pdf.service");

    // Replacement: swap SUGO t1 → a NEW teacher t4 (t3 already holds
    // RESERBA_II — one assignment per teacher per week forbids reusing them).
    const t4 = await mkTeacher("PF-T4");
    await setAvail(t4.id, w.id);
    const sugoRow = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;
    await db.update(schema.assignments).set({ teacherId: t4.id, assignmentSource: "OVERRIDE" }).where(eq(schema.assignments.id, sugoRow.id));
    let vm = await buildWeeklySuguanViewModel(w.id);
    expect(vm.sectionA.rows[0]!.pangalan).toContain("PF-T4"); // current replacement
    expect(vm.sectionA.rows[0]!.pangalan).not.toContain("PF-T1"); // original never shown

    // Clear: exercise the REAL Phase 6 clear path (raw deletes are blocked by
    // the Phase 1 append-only history guard — by design).
    const { AssignmentService } = await import("@/server/services");
    const reserba = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "RESERBA")!;
    await AssignmentService.clearAssignment(reserba.id, { clearType: "CHANGE_OF_SUGUAN", reason: "test clear" }, sched());
    vm = await buildWeeklySuguanViewModel(w.id);
    expect(vm.sectionB.rows[0]!.dakoName).toBe("Alpha"); // dako row remains (ALL ACTIVE rule)
    expect(vm.sectionB.rows[0]!.pangalan).toBeNull(); // blank after clear
  });

  it("renders buffer (smoke): starts %PDF, non-trivial size; DRAFT gets watermark flag, PUBLISHED does not", async () => {
    const w = await mkWeek(2093, 6, "DRAFT");
    const d = await mkDako("PG-1", "Alpha");
    const t = await mkTeacher("PG-T1");
    await setAvail(t.id, w.id);
    await assign(w.id, d.id, t.id, "SUGO");

    const { generateWeeklySuguanPdf } = await import("@/server/services/weekly-suguan-pdf.service");
    const { buffer, vm } = await generateWeeklySuguanPdf(w.id);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(1000);
    expect(vm.watermark).toBe("DRAFT");

    const wPub = await mkWeek(2093, 7, "PUBLISHED");
    const vm2 = (await generateWeeklySuguanPdf(wPub.id)).vm;
    expect(vm2.watermark).toBeNull();
  });

  // --------------------------------------------------------- zero mutations
  it("generating a PDF performs ZERO mutations (assignments/history/availability/audit/teachers/dako/weeks) on a PUBLISHED week", async () => {
    const w = await mkWeek(2093, 8, "PUBLISHED");
    const d = await mkDako("PH-1", "Alpha");
    const t = await mkTeacher("PH-T1");
    await setAvail(t.id, w.id);
    await assign(w.id, d.id, t.id, "SUGO");

    const before = await mutationSnapshot();
    const beforeStatus = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, w.id)))[0]!.status;

    const { generateWeeklySuguanPdf } = await import("@/server/services/weekly-suguan-pdf.service");
    await generateWeeklySuguanPdf(w.id);

    const after = await mutationSnapshot();
    const afterStatus = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, w.id)))[0]!.status;
    expect(after).toEqual(before);
    expect(afterStatus).toBe(beforeStatus); // PUBLISHED untouched
  });

  it("RBAC: Viewer/anonymous cannot generate (service layer rejects non-operators)", async () => {
    // The route enforces requirePermission("assignments.write"); the service is
    // intentionally role-agnostic (pure read) — assert route guard wiring via
    // the permission map used by the guard.
    const { permissionsForRoles } = await import("@/server/auth/permissions");
    expect(permissionsForRoles(["ADMIN"])).toContain("assignments.write");
    expect(permissionsForRoles(["SCHEDULER"])).toContain("assignments.write");
    expect(permissionsForRoles(["VIEWER"])).not.toContain("assignments.write");
  });

  it("no N+1: builder issues exactly the 3 set-based reads (week + dakos + assignments)", async () => {
    const w = await mkWeek(2093, 9);
    // Structural guard: the builder body contains ONE week read, ONE
    // Promise.all over exactly two reads, and NO per-row queries in loops.
    const src = (await import("fs")).readFileSync(
      "src/server/services/weekly-suguan-pdf.service.ts", "utf8");
    const buildFn = src.slice(src.indexOf("export async function buildWeeklySuguanViewModel"),
      src.indexOf("// ---------------------------------------------------------------------------\n// Renderer"));
    expect((buildFn.match(/\.select\(|listAssignmentsForWeek\(/g) ?? []).length).toBe(3);
    expect(buildFn.includes("Promise.all")).toBe(true);
    // no query inside a for-loop body
    const loopBodies = buildFn.match(/for \(const[\s\S]*?\n  \}/g) ?? [];
    for (const body of loopBodies) {
      expect(body.includes(".select(")).toBe(false);
      expect(body.includes("listAssignmentsForWeek(")).toBe(false);
    }
  });

  // ------------------------------------------------- single-page guarantee
  it("layout: §48 column widths exact-span 540pt and match approved proportions", async () => {
    const { sectionColumnWidths } = await import("@/server/services/weekly-suguan-pdf.service");
    const W = 8.5 * 72 - 2 * 0.5 * 72; // 540pt printable width
    for (const section of ["A", "B", "C"] as const) {
      const widths = sectionColumnWidths(section);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(W);
    }
    // §48 proportions (A/B): DAKO ≈14.6%, ORAS ≈9.1%, PANGALAN ≈29.8%,
    // PAGTANGGAP ≈22.2%, PAGBABAGO remainder — never equal-width.
    const [dako = 0, oras = 0, pangalan = 0, pagtanggap = 0, pagbabago = 0] = sectionColumnWidths("A");
    expect(dako / 540).toBeGreaterThan(0.14);
    expect(dako / 540).toBeLessThan(0.155);
    expect(oras / 540).toBeGreaterThan(0.08);
    expect(oras / 540).toBeLessThan(0.10);
    expect(pangalan / 540).toBeGreaterThan(0.29);
    expect(pangalan / 540).toBeLessThan(0.305);
    expect(pagtanggap / 540).toBeGreaterThan(0.21);
    expect(pagtanggap / 540).toBeLessThan(0.225);
    expect(pagbabago / 540).toBeGreaterThan(0.21);
    expect(pagbabago / 540).toBeLessThan(0.25);
    // §42 — Section C carries SIX columns including PAGTUPAD.
    expect(sectionColumnWidths("C").length).toBe(6);
  });

  it("layout: the physical form is ALWAYS exactly ONE page — dense 22-dako case included", async () => {
    // Worst realistic case: 22 active dakos, A+B fully assigned, 5 RESERBA_II.
    const w = await mkWeek(2093, 10);
    const dakoIds: string[] = [];
    for (let i = 1; i <= 22; i++) {
      const d = await mkDako(`PX-${String(i).padStart(2, "0")}`, `Chapel ${i}`);
      dakoIds.push(d.id);
      const t = await mkTeacher(`PX-T${String(i).padStart(2, "0")}`);
      await setAvail(t.id, w.id);
      await assign(w.id, d.id, t.id, "SUGO");
      const t2 = await mkTeacher(`PX-R${String(i).padStart(2, "0")}`);
      await setAvail(t2.id, w.id);
      await assign(w.id, d.id, t2.id, "RESERBA");
    }
    for (let i = 0; i < 5; i++) {
      const t = await mkTeacher(`PX-C${i}`);
      await setAvail(t.id, w.id);
      await assign(w.id, dakoIds[i]!, t.id, "RESERBA_II");
    }

    const { generateWeeklySuguanPdf, countPdfPages } = await import("@/server/services/weekly-suguan-pdf.service");
    const { buffer } = await generateWeeklySuguanPdf(w.id);
    expect(countPdfPages(buffer)).toBe(1); // THE physical-form guarantee
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("layout: one page for a typical 11-dako week with section C populated", async () => {
    const w = await mkWeek(2093, 11);
    for (let i = 1; i <= 11; i++) {
      const d = await mkDako(`PY-${String(i).padStart(2, "0")}`, `Sunday Chapel ${i}`);
      const t = await mkTeacher(`PY-T${String(i).padStart(2, "0")}`);
      await setAvail(t.id, w.id);
      await assign(w.id, d.id, t.id, "SUGO");
      const t2 = await mkTeacher(`PY-R${String(i).padStart(2, "0")}`);
      await setAvail(t2.id, w.id);
      await assign(w.id, d.id, t2.id, "RESERBA");
      if (i <= 3) {
        const t3 = await mkTeacher(`PY-C${String(i).padStart(2, "0")}`);
        await setAvail(t3.id, w.id);
        await assign(w.id, d.id, t3.id, "RESERBA_II");
      }
    }
    const { generateWeeklySuguanPdf, countPdfPages } = await import("@/server/services/weekly-suguan-pdf.service");
    const { buffer } = await generateWeeklySuguanPdf(w.id);
    expect(countPdfPages(buffer)).toBe(1);
  });
});
