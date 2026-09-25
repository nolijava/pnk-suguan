/**
 * Regression — the boot-time celebration scan used to CRASH on the grouped
 * oath-anniversary notice (#2): a date-based group key ("2026-09/24") was
 * written into notifications.related_entity_id, which is a uuid column, so
 * the insert failed with `invalid input syntax for type uuid` and the whole
 * scan aborted. A group notice has no single entity — it must record with a
 * null relatedEntityId and stay idempotent via the dedupe table.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { recordTeacherAnniversaryGroupNotice } from "@/server/services/celebration.service";

const input = () => ({
  month: 9,
  day: 24,
  anniversaryYear: 2026,
  notificationType: "TODAY",
  teachersInGroup: [
    { teacherId: "11111111-1111-4111-8111-111111111111", teacherName: "Pedro Garcia Reyes, Jr.", completedYears: 5 },
    { teacherId: "22222222-2222-4222-8222-222222222222", teacherName: "Juan Dela Cruz", completedYears: 5 },
  ],
});

describe("teacher anniversary GROUP notice (boot-time scan regression)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedAdmin(); // ADMIN fan-out recipient
  });

  afterAll(async () => {
    await teardown();
  });

  it("records the grouped notice without a phantom uuid", async () => {
    const result = await recordTeacherAnniversaryGroupNotice(input());
    expect(result).toEqual({ created: true, notifications: 1 });

    const rows = await db.select().from(schema.notifications);
    expect(rows.length).toBe(1);
    expect(rows[0]!.relatedEntityType).toBe("teacher_anniversary_group");
    // The very bug under regression test: never a date key in a uuid column.
    expect(rows[0]!.relatedEntityId).toBeNull();
    expect(rows[0]!.title).toContain("09/24");
    expect(rows[0]!.message).toContain("Pedro Garcia Reyes, Jr. (5 years)");
    expect(rows[0]!.message).toContain("Juan Dela Cruz (5 years)");

    // The group identity/dedupe row was recorded alongside.
    const groups = await db.select().from(schema.teacherAnniversaryNotifications);
    expect(groups.length).toBe(1);
    expect(groups[0]!.notificationType).toBe("TODAY");
  });

  it("is idempotent — a second scan pass creates nothing", async () => {
    await recordTeacherAnniversaryGroupNotice(input());
    const second = await recordTeacherAnniversaryGroupNotice(input());
    expect(second).toEqual({ created: false, notifications: 0 });
    expect((await db.select().from(schema.notifications)).length).toBe(1);
    expect((await db.select().from(schema.teacherAnniversaryNotifications)).length).toBe(1);
  });
});
