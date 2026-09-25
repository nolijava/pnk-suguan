/**
 * E2E database + sandbox seed. Executed by `tsx` before the e2e dev server
 * starts (playwright.config.ts webServer.command) — `tsx` resolves the app's
 * `@/` aliases so the REAL services create the records.
 *
 * Seeds exactly what the smoke flows need:
 *  - an admin login (tests/int/helpers seedAdmin) plus a read-only VIEWER login,
 *  - one ACTIVE dako with a full duty roster (1 Destinado + 2 Katuwang, all
 *    with that dako as Current Destination) and availability for the CURRENT
 *    ISO week — the week the dashboard's Generate Suguan modal targets, so the
 *    Assign Katuwang smoke run produces real slots,
 *  - the sandbox folders/empty dialog-stub file the backup dialogs use.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resetTestDb, seedAdmin, seedViewer, teardown, db } from "../tests/int/helpers";
import * as schema from "../src/server/db/schema";
import { TeacherService, DakoService } from "../src/server/services";
import type { SessionUser } from "../src/server/auth/session";
import { isoWeek, isoWeekStart } from "../src/lib/iso-week";
import { BACKUP_DIR, CUSTOM_DIR, DIALOG_STUB_FILE } from "./paths";

function actor(userId: string): SessionUser {
  return {
    userId,
    email: "admin@test.local",
    fullName: "Test Admin",
    mustChangePassword: false,
    roleCodes: ["ADMIN"],
    permissions: [],
  };
}

/** ISO week (year, 1-based week) of a date — the app's own ISO math. */
function isoWeekOf(d: Date): { year: number; week: number } {
  return isoWeek(d);
}

/** Monday (UTC) of the given ISO week — as YYYY-MM-DD. */
function weekStart(year: number, week: number): string {
  return isoWeekStart(year, week).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  // Sandboxes first — the seeded world must match what the specs expect.
  mkdirSync(BACKUP_DIR, { recursive: true });
  mkdirSync(CUSTOM_DIR, { recursive: true });
  writeFileSync(DIALOG_STUB_FILE, ""); // empty = "the user cancelled"

  await resetTestDb();
  const adminId = await seedAdmin();
  const admin = actor(adminId);
  // A read-only login so the navigation spec can prove gated entries are ABSENT
  // (not disabled) for a role that does not hold users.manage / backups.* / ADMIN.
  await seedViewer();

  const dako = await DakoService.createDako(
    {
      dakoCode: "E2E-1",
      name: "E2E Dako",
      address: "1 Test St",
      dateEstablished: "2001-06-15",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language: "FILIPINO",
    } as Parameters<typeof DakoService.createDako>[0],
    admin,
  );

  // E2E-A deliberately carries a MIDDLE NAME + SUFFIX: the dashboard must show
  // `Destinado Alfa, Jr.` — middle name hidden (Update #12), suffix kept
  // (Update #3) — which the dashboard-name smoke test asserts.
  const roster: {
    code: string;
    first: string;
    last: string;
    middle?: string;
    suffix?: string;
    duty: "DESTINADO" | "KATUWANG";
  }[] = [
    { code: "E2E-A", first: "Destinado", last: "Alfa", middle: "Middle", suffix: "Jr.", duty: "DESTINADO" },
    { code: "E2E-B", first: "Katuwang", last: "Bravo", duty: "KATUWANG" },
    { code: "E2E-C", first: "Katuwang", last: "Charlie", duty: "KATUWANG" },
  ];
  const teachers = [];
  for (const t of roster) {
    teachers.push(
      await TeacherService.createTeacher(
        {
          teacherCode: t.code,
          firstName: t.first,
          lastName: t.last,
          ...(t.middle ? { middleName: t.middle } : {}),
          ...(t.suffix ? { suffix: t.suffix } : {}),
          language: "FILIPINO",
          duty: t.duty,
          currentDestinationId: dako.id,
        } as Parameters<typeof TeacherService.createTeacher>[0],
        admin,
      ),
    );
  }

  // Availability for the CURRENT ISO week (the Generate Suguan modal's default
  // target) AND the NEXT one, so "the SELECTED week is actually generated" can
  // be proven on a non-default week. Every OTHER week stays unencoded on
  // purpose — the availability-block specs need a week the gate must reject.
  const current = isoWeekOf(new Date());
  const nextMonday = isoWeekStart(current.year, current.week);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const next = isoWeekOf(nextMonday);

  const seeded: { year: number; week: number }[] = [];
  for (const target of [current, next]) {
    if (seeded.some((w) => w.year === target.year && w.week === target.week)) continue;
    seeded.push(target);
    const start = weekStart(target.year, target.week);
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    const weekRows = await db
      .insert(schema.weeks)
      .values({
        year: target.year,
        isoWeekNumber: target.week,
        startDate: start,
        endDate: end.toISOString().slice(0, 10),
        status: "DRAFT",
      })
      .returning();
    const weekId = weekRows[0]!.id;
    for (const t of teachers) {
      await db
        .insert(schema.teacherAvailability)
        .values({ teacherId: t.id, weekId, availabilityStatus: "AVAILABLE", reason: null });
    }
  }

  await teardown();
  console.log(
    `[e2e seed] ready — dako ${dako.dakoCode}, ${teachers.length} teachers, weeks ` +
      seeded.map((w) => `${w.year}-W${w.week}`).join(", "),
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[e2e seed] FAILED:", err);
    process.exit(1);
  },
);
