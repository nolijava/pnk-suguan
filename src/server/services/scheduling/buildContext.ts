/**
 * Phase 4 — scheduling context builder (§19 performance strategy).
 * A handful of set-based queries materialize everything the pure core needs;
 * all eligibility/scoring/allocation then run in memory.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  assignments,
  dako,
  teachers,
  teacherAvailability,
  weeks,
} from "@/server/db/schema";
import { NotFoundError } from "@/lib/errors";
import { isoWeek } from "@/lib/iso-week";
import { wasAbsentPreviousWeekBatch } from "../availability.service";
import type { SchedulingContext } from "./types";

export async function buildSchedulingContext(
  weekId: string,
  tx?: Database,
): Promise<SchedulingContext> {
  const db = tx ?? getDb();

  const wRows = await db.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  const w = wRows[0];
  if (!w) throw new NotFoundError("week not found");

  const [teacherRows, dakoRows, availRows] = await Promise.all([
    db.select().from(teachers),
    db.select().from(dako),
    db
      .select({
        teacherId: teacherAvailability.teacherId,
        status: teacherAvailability.availabilityStatus,
        reason: teacherAvailability.reason,
      })
      .from(teacherAvailability)
      .where(eq(teacherAvailability.weekId, weekId)),
  ]);

  const prevWeekAbsent = await wasAbsentPreviousWeekBatch(weekId);

  const countRows = await db
    .select({
      teacherId: assignments.teacherId,
      dakoId: assignments.dakoId,
      assignmentType: assignments.assignmentType,
      total: sql<number>`count(*)::int`,
      yearTotal: sql<number>`count(*) filter (where ${weeks.year} = ${w.year})::int`,
      lastAssignedAt: sql<string | null>`max(${assignments.assignedAt})::text`,
    })
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .where(eq(assignments.status, "ASSIGNED"))
    .groupBy(assignments.teacherId, assignments.dakoId, assignments.assignmentType);

  const weekAssignRows = await db
    .select({
      id: assignments.id,
      teacherId: assignments.teacherId,
      dakoId: assignments.dakoId,
      assignmentType: assignments.assignmentType,
      assignmentSource: assignments.assignmentSource,
    })
    .from(assignments)
    .where(eq(assignments.weekId, weekId));

  // Previous week's teacher→dako map for consecutive/recency tie-breakers (§8).
  const prevWeekId = await previousWeekId(db, weekId);
  const prevWeekAssign = new Map<string, string>();
  if (prevWeekId) {
    const prevRows = await db
      .select({ teacherId: assignments.teacherId, dakoId: assignments.dakoId })
      .from(assignments)
      .where(eq(assignments.weekId, prevWeekId));
    for (const r of prevRows) prevWeekAssign.set(r.teacherId, r.dakoId);
  }

  return {
    weekId: w.id,
    year: w.year,
    isoWeekNumber: w.isoWeekNumber,
    weekStatus: w.status,
    teachers: teacherRows.map((t) => ({
      teacherId: t.id,
      teacherCode: t.teacherCode,
      fullName: [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" "),
      language: t.language as "FILIPINO" | "ENGLISH",
      status: t.status,
      currentDestinationId: t.currentDestinationId ?? null,
    })),
    dakos: dakoRows.map((d) => ({
      dakoId: d.id,
      dakoCode: d.dakoCode,
      dakoName: d.name,
      language: d.language as "FILIPINO" | "ENGLISH",
      status: d.status,
    })),
    availability: new Map(
      availRows.map((a) => [a.teacherId, { status: a.status, reason: a.reason }]),
    ),
    prevWeekAbsent,
    counts: new Map(
      countRows.map((r) => [
        `${r.teacherId}|${r.dakoId}|${r.assignmentType}`,
        { total: r.total, yearTotal: r.yearTotal, lastAssignedAt: r.lastAssignedAt },
      ]),
    ),
    weekAssignments: new Map(
      weekAssignRows
        .filter((r) => r.assignmentSource !== "AUTO")
        .map((r) => [
          r.teacherId,
          { teacherId: r.teacherId, assignmentType: r.assignmentType, assignmentSource: r.assignmentSource },
        ]),
    ),
    occupiedSlots: new Set(
      weekAssignRows
        .filter((r) => r.assignmentSource !== "AUTO")
        .map((r) => `${r.dakoId}|${r.assignmentType}`),
    ),
    // Only MANUAL/OVERRIDE teachers are immovable for regeneration; AUTO
    // teachers are replaced by this generation and must NOT block re-allocation.
    immovableTeachers: new Set(
      weekAssignRows
        .filter((r) => r.assignmentSource !== "AUTO")
        .map((r) => r.teacherId),
    ),
    prevWeekAssignment: prevWeekAssign,
  };
}

async function previousWeekId(db: Database, weekId: string): Promise<string | null> {
  const cur = await db.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  const w = cur[0];
  if (!w) return null;
  const start = new Date(`${w.startDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7);
  // ISO week-year (not calendar year) — matches weeks.year semantics.
  const prev = isoWeek(start);
  const prevRows = await db
    .select({ id: weeks.id })
    .from(weeks)
    .where(and(eq(weeks.year, prev.year), eq(weeks.isoWeekNumber, prev.week)))
    .limit(1);
  return prevRows[0]?.id ?? null;
}
