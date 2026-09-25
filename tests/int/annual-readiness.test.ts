/**
 * Update #23 — per-week Weekly Availability READINESS for the Annual matrix.
 *
 * The dashboard renders one readiness mark per ISO-week column so an operator
 * sees which weeks are ready and which generation would be BLOCKED before
 * pressing Confirm. That indicator is only trustworthy if it agrees with the
 * generation gate, so this suite pins the agreement on the real database:
 *
 *   1. It covers every ISO week of the year (52 or 53 via the ISO math) and is
 *      READ-ONLY — probing a year never creates a week row.
 *   2. A week is ready exactly when every master-ACTIVE teacher has a row for
 *      it; an ENCODED-but-ABSENT row still counts (the prerequisite is about the
 *      row existing, not its value).
 *   3. Master-INACTIVE teachers are never required and their stale rows never
 *      count toward coverage (the same set the gate counts).
 *   4. Week 53 appears only in the years that actually have one.
 *   5. An empty roster is trivially ready — nothing is required.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { AvailabilityService, DakoService, TeacherService, WeekService } from "@/server/services";
import { isoWeeksInYear } from "@/lib/iso-week";
import type { SessionUser } from "@/server/auth/session";

const YEAR = 2033; // an ordinary year, well clear of the go-live window
const YEAR_53 = 2032; // a real 53-week ISO year
const YEAR_52 = 2031; // ...and a real 52-week one

let actor: SessionUser;
let dakoId: string;

async function makeTeacher(code: string) {
  return TeacherService.createTeacher(
    {
      teacherCode: code,
      firstName: "Readiness",
      lastName: code,
      language: "FILIPINO",
      duty: "DESTINADO",
      currentDestinationId: dakoId,
    } as Parameters<typeof TeacherService.createTeacher>[0],
    actor,
  );
}

/** Encode ONE row per given teacher for the week. */
async function encodeAll(weekId: string, teacherIds: string[]) {
  for (const id of teacherIds) {
    await db
      .insert(schema.teacherAvailability)
      .values({ teacherId: id, weekId, availabilityStatus: "AVAILABLE" });
  }
}

beforeEach(async () => {
  await resetTestDb();
  const adminId = await seedAdmin();
  actor = {
    userId: adminId,
    email: "admin@test.local",
    fullName: "Test Admin",
    mustChangePassword: false,
    roleCodes: ["ADMIN"],
    permissions: [],
  };
  const dako = await DakoService.createDako(
    {
      dakoCode: "RDY-D",
      name: "Readiness Dako",
      address: "1 Readiness St",
      dateEstablished: "2001-06-15",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language: "FILIPINO",
    } as Parameters<typeof DakoService.createDako>[0],
    actor,
  );
  dakoId = dako.id;
});

afterAll(async () => {
  await teardown();
});

describe("Update #23 — annual Weekly Availability readiness", () => {
  it("covers every ISO week of the year, read-only, without creating a week row", async () => {
    await makeTeacher("RDY-A");
    const weekCount = isoWeeksInYear(YEAR);

    const readiness = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR);

    expect(Object.keys(readiness)).toHaveLength(weekCount);
    for (let w = 1; w <= weekCount; w++) {
      // No week started yet ⇒ every required teacher is missing.
      expect(readiness[w], `week ${w}`).toMatchObject({
        week: w,
        ready: false,
        missing: 1,
        total: 1,
        weekId: null,
      });
    }

    // Read-only: the probe must never materialize a week.
    const rows = await db.select().from(schema.weeks).where(eq(schema.weeks.year, YEAR));
    expect(rows).toHaveLength(0);
  });

  it("is ready for a fully encoded week and blocked for a partial one", async () => {
    const ids: string[] = [];
    for (const code of ["RDY-B", "RDY-C", "RDY-D"]) ids.push((await makeTeacher(code)).id);

    const full = await WeekService.resolveWeek({ year: YEAR, week: 5 });
    await encodeAll(full.id, ids);

    const partial = await WeekService.resolveWeek({ year: YEAR, week: 6 });
    // ABSENT is still ENCODED — the prerequisite is the row existing.
    await db
      .insert(schema.teacherAvailability)
      .values({ teacherId: ids[0]!, weekId: partial.id, availabilityStatus: "ABSENT" });

    const readiness = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR);

    expect(readiness[5]).toMatchObject({ ready: true, missing: 0, total: 3, weekId: full.id });
    expect(readiness[6]).toMatchObject({ ready: false, missing: 2, total: 3, weekId: partial.id });
    // A week with no row at all is entirely missing.
    expect(readiness[7]).toMatchObject({ ready: false, missing: 3, total: 3, weekId: null });
  });

  it("never requires master-INACTIVE teachers and ignores their stale rows", async () => {
    const a = await makeTeacher("RDY-E");
    const b = await makeTeacher("RDY-F");
    const retired = await makeTeacher("RDY-G");
    const week = await WeekService.resolveWeek({ year: YEAR, week: 8 });

    // Encode ONLY the teacher who then becomes inactive: the two required
    // teachers are still missing, so the stale row must not inflate coverage.
    await encodeAll(week.id, [retired.id]);
    await TeacherService.deactivateTeacher(retired.id, "retired", actor);

    const blocked = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR);
    expect(blocked[8]).toMatchObject({ total: 2, missing: 2, ready: false });

    await encodeAll(week.id, [a.id, b.id]);
    const ready = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR);
    expect(ready[8]).toMatchObject({ total: 2, missing: 0, ready: true });
  });

  it("exposes week 53 only in the years that have one", async () => {
    expect(isoWeeksInYear(YEAR_53)).toBe(53);
    expect(isoWeeksInYear(YEAR_52)).toBe(52);

    const with53 = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR_53);
    expect(with53[53]).toMatchObject({ week: 53, weekId: null });
    expect(with53[52]).toMatchObject({ week: 52 });

    const with52 = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR_52);
    expect(with52[53]).toBeUndefined();
    expect(with52[52]).toMatchObject({ week: 52 });
  });

  it("treats an empty roster as trivially ready — nothing is required", async () => {
    const readiness = await AvailabilityService.getAnnualAvailabilityReadiness(YEAR);
    expect(readiness[1]).toMatchObject({ total: 0, missing: 0, ready: true });
  });
});
