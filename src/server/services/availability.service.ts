import { and, eq, desc } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { teacherAvailability, weeks, teachers } from "@/server/db/schema";
import { availabilityUpsertSchema, type AvailabilityUpsertInput } from "@/lib/validation/schemas";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";

/** Upsert one weekly availability record (§17). Never touches the teacher profile (§18). */
export async function upsertAvailability(
  input: AvailabilityUpsertInput,
  actor: SessionUser,
): Promise<typeof teacherAvailability.$inferSelect> {
  availabilityUpsertSchema.parse(input);
  return withTransaction(async (tx) => {
    const t = await tx.select().from(teachers).where(eq(teachers.id, input.teacherId)).limit(1);
    if (t.length === 0) throw new NotFoundError("teacher not found");
    const w = await tx.select().from(weeks).where(eq(weeks.id, input.weekId)).limit(1);
    if (w.length === 0) throw new NotFoundError("week not found");

    if (input.availabilityStatus === "ABSENT" && !input.reason) {
      throw new ValidationError("reason is required when marking a teacher ABSENT");
    }

    const existing = await tx
      .select()
      .from(teacherAvailability)
      .where(
        and(
          eq(teacherAvailability.teacherId, input.teacherId),
          eq(teacherAvailability.weekId, input.weekId),
        ),
      )
      .limit(1);

    let row: typeof teacherAvailability.$inferSelect;
    if (existing.length > 0) {
      const updated = await tx
        .update(teacherAvailability)
        .set({
          availabilityStatus: input.availabilityStatus,
          reason: input.reason ?? null,
          remarks: input.remarks ?? null,
        })
        .where(eq(teacherAvailability.id, existing[0]!.id))
        .returning();
      row = updated[0]!;
    } else {
      const inserted = await tx.insert(teacherAvailability).values(input).returning();
      row = inserted[0]!;
    }
    await audit(
      {
        user: actor,
        action: "UPSERTED_AVAILABILITY",
        entityType: "teacher_availability",
        entityId: row.id,
        oldValue: existing[0] ?? null,
        newValue: row,
        reason: input.reason ?? null,
      },
      tx as Database,
    );
    return row;
  });
}

export async function listAvailabilityForWeek(weekId: string) {
  return getDb()
    .select({
      id: teacherAvailability.id,
      teacherId: teacherAvailability.teacherId,
      availabilityStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
      remarks: teacherAvailability.remarks,
    })
    .from(teacherAvailability)
    .where(eq(teacherAvailability.weekId, weekId));
}

/** §18: was the teacher absent in the ISO week before `year/week`? (scheduler input) */
export async function wasAbsentPreviousWeek(
  teacherId: string,
  year: number,
  isoWeekNumber: number,
): Promise<boolean> {
  // Previous ISO week via date arithmetic — handles year wrap (week 1 → 52/53).
  const { isoWeekStart, isoWeek } = await import("@/lib/iso-week");
  const prevStart = new Date(isoWeekStart(year, isoWeekNumber));
  prevStart.setUTCDate(prevStart.getUTCDate() - 7);
  const prev = isoWeek(prevStart);
  const rows = await getDb()
    .select({ id: teacherAvailability.id })
    .from(teacherAvailability)
    .innerJoin(weeks, eq(weeks.id, teacherAvailability.weekId))
    .where(
      and(
        eq(teacherAvailability.teacherId, teacherId),
        eq(teacherAvailability.availabilityStatus, "ABSENT"),
        eq(weeks.year, prev.year),
        eq(weeks.isoWeekNumber, prev.week),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function latestAvailabilityForTeacher(teacherId: string, limit = 10) {
  return getDb()
    .select({
      year: weeks.year,
      isoWeekNumber: weeks.isoWeekNumber,
      availabilityStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
    })
    .from(teacherAvailability)
    .innerJoin(weeks, eq(weeks.id, teacherAvailability.weekId))
    .where(eq(teacherAvailability.teacherId, teacherId))
    .orderBy(desc(weeks.startDate))
    .limit(limit);
}
