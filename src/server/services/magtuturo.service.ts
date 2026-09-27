/**
 * Update #21 — MGA MAGTUTURO SA KLASE service.
 *
 * A STANDALONE assignment category, logically separate from normal
 * SUGO/RESERBA/RESERBA II (21.14/21.15): the `assignments` table, its unique
 * indexes and the scheduling engine are never touched. Exactly 4 SUGO
 * (seats 1-4) + 2 RESERBA (seats 1-2) per week — 6 assignments per week.
 *
 * Special rules (21.3-21.8):
 *  - ABSENT is NOT a hard exclusion — it drives continuity:
 *    21.4  absent SUGO carries over as SUGO next week;
 *    21.5  non-absent RESERBA is promoted to SUGO next week (beats rotation).
 *  - 21.6  a teacher assigned to an ENGLISH dako the same week is EXCLUDED.
 *  - 21.7  weekly INACTIVE always excludes. Master INACTIVE, NOT_ENCODED and
 *    oath-date eligibility stay hard rules (21.8); Update #5 oath compare is
 *    calendar-date based and non-overridable.
 *
 * Magtuturo rotation is independent of regular Suguan duty and Current
 * Destination. Eligible candidates share one global pool ranked only by
 * Magtuturo assignment count, oldest last assignment, and teacher ID.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import {
  assignments,
  dako,
  magtuturoAssignments,
  teacherAvailability,
  teachers,
  weeks,
} from "@/server/db/schema";
import { formatFullName } from "@/lib/name";
import { isoWeek, isoWeekDates, isoWeeksInYear } from "@/lib/iso-week";
import { isTeacherEligibleForDako, type Language } from "@/lib/eligibility";
import { audit } from "@/server/services/audit.service";
import type { SessionUser } from "@/server/auth/session";

export type MagType = "SUGO" | "RESERBA";
export const MAG_TYPES: readonly MagType[] = ["SUGO", "RESERBA"];
export const MAG_SEATS: Record<MagType, number> = { SUGO: 4, RESERBA: 2 };

export type MagUser = Pick<SessionUser, "userId"> | null;

export interface MagtuturoWeekRow {
  id: string;
  weekId: string;
  teacherId: string;
  teacherName: string;
  teacherCode: string;
  magType: MagType;
  seat: number;
  assignmentSource: string;
  isOverride: boolean;
  overrideReason: string | null;
}

interface TeacherCore {
  id: string;
  teacherCode: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  language: string;
  status: string;
  dateOfOath: string | null;
}

/** Per-teacher Magtuturo rotation stats (all-time, from past seats). */
type RotationRank = Map<string, { count: number; last: number }>;

/** Candidate order uses Magtuturo history only; older assignments break count ties. */
export interface MagtuturoRotationCandidate {
  teacherId: string;
  count: number;
  lastAssignment: number;
}

export function compareMagtuturoRotation(
  a: MagtuturoRotationCandidate,
  b: MagtuturoRotationCandidate,
): number {
  if (a.count !== b.count) return a.count - b.count;
  if (a.lastAssignment !== b.lastAssignment) return a.lastAssignment - b.lastAssignment;
  return a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0;
}

/** Hard eligibility for Magtuturo (21.6-21.8). ABSENT is NOT a violation (21.3). */
function magtuturoViolations(
  t: TeacherCore,
  weeklyStatus: string | undefined,
  englishDakoAssigned: boolean,
  weekServiceDate: string,
): string[] {
  const v: string[] = [];
  if (t.status !== "ACTIVE") v.push("TEACHER_INACTIVE_MASTER"); // master precedence
  if (weeklyStatus === undefined) v.push("NOT_ENCODED");
  else if (weeklyStatus === "INACTIVE") v.push("INACTIVE_WEEKLY"); // 21.7
  // 21.3: ABSENT stays eligible (continuity rules decide placement).
  if (englishDakoAssigned) v.push("ENGLISH_DAKO_EXCLUSION"); // 21.6 hard
  if (t.dateOfOath && weekServiceDate < t.dateOfOath) v.push("OATH_DATE_NOT_REACHED"); // #5
  return v;
}

export interface MagtuturoEligibility {
  teacherId: string;
  teacherName: string;
  eligible: boolean;
  violatedRules: string[];
}

/** Read-only eligibility probe for the UI (21.10 validation feedback). */
export async function magtuturoEligibility(weekId: string): Promise<MagtuturoEligibility[]> {
  const db = getDb();
  const week = await getWeek(weekId);
  const [weekly, english, seatedRows, all] = await Promise.all([
    weeklyStatuses(weekId, db),
    englishDakoTeacherIds(weekId, db),
    db.select({ teacherId: magtuturoAssignments.teacherId })
      .from(magtuturoAssignments)
      .where(eq(magtuturoAssignments.weekId, weekId)),
    db.select().from(teachers),
  ]);
  const seated = new Set(seatedRows.map((row) => row.teacherId));
  return (all as TeacherCore[]).map((t) => {
    const violated = magtuturoViolations(t, weekly.get(t.id), english.has(t.id), week.endDate);
    if (seated.has(t.id)) violated.push("ALREADY_ASSIGNED_MAGTUTURO");
    return {
      teacherId: t.id,
      teacherName: formatFullName(t),
      eligible: violated.length === 0,
      violatedRules: violated,
    };
  });
}

async function getWeek(weekId: string, db: Database = getDb()) {
  const [week] = await db.select().from(weeks).where(eq(weeks.id, weekId));
  if (!week) throw new Error("Week not found");
  return week;
}

async function weeklyStatuses(weekId: string, db: Database = getDb()): Promise<Map<string, string>> {
  const rows = await db.select().from(teacherAvailability).where(eq(teacherAvailability.weekId, weekId));
  return new Map(rows.map((r: typeof teacherAvailability.$inferSelect) => [r.teacherId, r.availabilityStatus]));
}

/** Teachers assigned to an ENGLISH dako this week (21.6 hard exclusion). */
async function englishDakoTeacherIds(weekId: string, db: Database = getDb()): Promise<Set<string>> {
  const rows = await db
    .select({ teacherId: assignments.teacherId })
    .from(assignments)
    .innerJoin(dako, eq(assignments.dakoId, dako.id))
    .where(and(eq(assignments.weekId, weekId), eq(dako.language, "ENGLISH")));
  return new Set(rows.map((r: { teacherId: string }) => r.teacherId));
}

/** Latest earlier recorded ISO week — preserves the existing continuity lookup semantics. */
async function priorWeek(
  week: { id: string; year: number; isoWeekNumber: number },
  db: Database = getDb(),
) {
  const candidates = await db.select().from(weeks).where(inArray(weeks.year, [week.year - 1, week.year]));
  const before = candidates
    .filter((candidate) =>
      candidate.id !== week.id &&
      (candidate.year < week.year || (candidate.year === week.year && candidate.isoWeekNumber < week.isoWeekNumber)),
    )
    .sort((a, b) => b.year - a.year || b.isoWeekNumber - a.isoWeekNumber);
  return before[0] ?? null;
}

/** Fair rotation (21.2): least-loaded first, then longest since last seat. */
async function rotationRank(db: Database = getDb()): Promise<Map<string, { count: number; last: number }>> {
  const rows = await db.select().from(magtuturoAssignments).orderBy(asc(magtuturoAssignments.assignedAt));
  const rank = new Map<string, { count: number; last: number }>();
  for (const r of rows) {
    const cur = rank.get(r.teacherId) ?? { count: 0, last: 0 };
    rank.set(r.teacherId, { count: cur.count + 1, last: Math.max(cur.last, r.assignedAt.getTime()) });
  }
  return rank;
}

export interface GenerateResult {
  weekId: string;
  year?: number;
  isoWeekNumber?: number;
  detail: string[];
  created: number;
  skipped: boolean;
  reason?: string;
}

export interface MagtuturoHistoryRow extends MagtuturoWeekRow {
  year: number;
  isoWeekNumber: number;
}

export interface MonthlyGenerateResult {
  weeks: GenerateResult[];
  created: number;
  year: number;
  month: number;
}

function compareRoleSeat(a: { magType: string; seat: number }, b: { magType: string; seat: number }): number {
  const typeOrder = (type: string) => type === "SUGO" ? 0 : 1;
  return typeOrder(a.magType) - typeOrder(b.magType) || a.seat - b.seat;
}

function fillSeatHoles(existing: Map<number, string>, ids: string[], count: number): Map<number, string> | null {
  const result = new Map(existing);
  const free = Array.from({ length: count }, (_, i) => i + 1).filter((seat) => !result.has(seat));
  if (ids.length > free.length) return null;
  ids.forEach((id, i) => result.set(free[i]!, id));
  return result;
}

/** Existing policy/algorithm, executed in the caller's transaction. */
async function generateMagtuturoWeekInTransaction(
  tx: Database,
  weekId: string,
  user: MagUser,
  options: { preserveManual: boolean; onlyIfEmpty?: boolean } = { preserveManual: true },
): Promise<GenerateResult> {
  const weekRows = await tx.select().from(weeks).where(eq(weeks.id, weekId)).for("update").limit(1);
  const week = weekRows[0];
  if (!week) throw new Error("Week not found");
  const resultWeek = { year: week.year, isoWeekNumber: week.isoWeekNumber };
  if (week.status !== "DRAFT") {
    return { weekId, ...resultWeek, detail: [], created: 0, skipped: true, reason: `week is ${week.status} — generation is DRAFT-only` };
  }

  const existingRows = await tx.select().from(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, weekId));
  if (options.onlyIfEmpty && existingRows.length > 0) {
    return { weekId, ...resultWeek, detail: [], created: 0, skipped: true, reason: "week already has Magtuturo assignments" };
  }
  const manualRows = options.preserveManual
    ? existingRows.filter((row) => row.assignmentSource !== "AUTO")
    : [];
  const detail: string[] = [];
  const weekly = await weeklyStatuses(weekId, tx);
  const english = await englishDakoTeacherIds(weekId, tx);
  const all: TeacherCore[] = await tx.select({
    id: teachers.id,
    teacherCode: teachers.teacherCode,
    firstName: teachers.firstName,
    middleName: teachers.middleName,
    lastName: teachers.lastName,
    suffix: teachers.suffix,
    language: teachers.language,
    status: teachers.status,
    dateOfOath: teachers.dateOfOath,
  }).from(teachers);
  const teacherById = new Map(all.map((teacher) => [teacher.id, teacher]));
  const eligible = new Map<string, TeacherCore>();
  for (const teacher of all) {
    if (magtuturoViolations(teacher, weekly.get(teacher.id), english.has(teacher.id), week.endDate).length === 0) {
      eligible.set(teacher.id, teacher);
    }
  }

  for (const row of manualRows) {
    const teacher = teacherById.get(row.teacherId);
    const violations = teacher
      ? magtuturoViolations(teacher, weekly.get(teacher.id), english.has(teacher.id), week.endDate)
      : ["TEACHER_NOT_FOUND"];
    if (violations.length > 0) {
      return {
        weekId,
        ...resultWeek,
        detail,
        created: 0,
        skipped: true,
        reason: `Manual ${row.magType} ${row.seat} conflicts with eligibility (${violations.join(", ")}); no assignments changed.`,
      };
    }
  }

  // Continuity is evaluated before rotation and never bypassed by regeneration.
  const keepSugo: string[] = [];
  const promote: string[] = [];
  const previous = await priorWeek(week, tx);
  if (previous) {
    const previousRows = await tx.select().from(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, previous.id));
    for (const row of [...previousRows].sort(compareRoleSeat)) {
      if (!eligible.has(row.teacherId)) continue; // protected hard rules win
      const absentNow = weekly.get(row.teacherId) === "ABSENT";
      if (row.magType === "SUGO" && absentNow) keepSugo.push(row.teacherId);
      if (row.magType === "RESERBA" && !absentNow) promote.push(row.teacherId);
    }
  }

  const manualSugo = new Map(manualRows.filter((row) => row.magType === "SUGO").map((row) => [row.seat, row.teacherId]));
  const manualReserba = new Map(manualRows.filter((row) => row.magType === "RESERBA").map((row) => [row.seat, row.teacherId]));
  const manuallySeated = new Set(manualRows.map((row) => row.teacherId));
  if (manuallySeated.size !== manualRows.length) {
    return { weekId, ...resultWeek, detail, created: 0, skipped: true, reason: "Manual assignments contain duplicate teachers; no assignments changed." };
  }
  const requiredSugo: string[] = [];
  for (const teacherId of [...keepSugo, ...promote]) {
    const manualType = manualRows.find((row) => row.teacherId === teacherId)?.magType;
    if (manualType === "RESERBA") {
      return {
        weekId,
        ...resultWeek,
        detail,
        created: 0,
        skipped: true,
        reason: `Manual RESERBA seat conflicts with continuity for teacher ${teacherId}; no assignments changed.`,
      };
    }
    if (!manuallySeated.has(teacherId) && !requiredSugo.includes(teacherId)) requiredSugo.push(teacherId);
  }
  if (requiredSugo.length > MAG_SEATS.SUGO - manualSugo.size) {
    return { weekId, ...resultWeek, detail, created: 0, skipped: true, reason: "Manual seats conflict with required SUGO continuity; no assignments changed." };
  }
  if (keepSugo.length) detail.push(`21.4 SUGO continuity: ${keepSugo.length} carried over (absent)`);
  if (promote.length) detail.push(`21.5 RESERBA progression: ${promote.length} promoted to SUGO`);

  const rank = await rotationRank(tx);
  const excludedFromRotation = new Set<string>([...manuallySeated, ...requiredSugo]);
  const pool = all
    .filter((teacher) => !excludedFromRotation.has(teacher.id) && eligible.has(teacher.id))
    .map((teacher) => {
      const stats = rank.get(teacher.id) ?? { count: 0, last: 0 };
      return { teacherId: teacher.id, count: stats.count, lastAssignment: stats.last };
    })
    .sort(compareMagtuturoRotation);
  const rotationCandidateCount = pool.length;
  const sugo = fillSeatHoles(manualSugo, requiredSugo, MAG_SEATS.SUGO);
  if (!sugo) return { weekId, detail, created: 0, skipped: true, reason: "Manual seats conflict with required SUGO continuity; no assignments changed." };
  while (sugo.size < MAG_SEATS.SUGO && pool.length) {
    const freeSeat = Array.from({ length: MAG_SEATS.SUGO }, (_, i) => i + 1).find((seat) => !sugo.has(seat))!;
    const teacherId = pool.shift()!.teacherId;
    sugo.set(freeSeat, teacherId);
  }
  const reserba = new Map(manualReserba);
  while (reserba.size < MAG_SEATS.RESERBA && pool.length) {
    const freeSeat = Array.from({ length: MAG_SEATS.RESERBA }, (_, i) => i + 1).find((seat) => !reserba.has(seat))!;
    const teacherId = pool.shift()!.teacherId;
    reserba.set(freeSeat, teacherId);
  }

  const previousAuto = existingRows.filter((row) => row.assignmentSource === "AUTO");
  if (!options.preserveManual && existingRows.length === 0) {
    // Empty-week monthly generation uses precisely the same weekly policy path.
  } else if (options.preserveManual) {
    await tx.delete(magtuturoAssignments).where(and(eq(magtuturoAssignments.weekId, weekId), eq(magtuturoAssignments.assignmentSource, "AUTO")));
  } else {
    return { weekId, ...resultWeek, detail, created: 0, skipped: true, reason: "week already has Magtuturo assignments" };
  }
  const now = new Date();
  const values: (typeof magtuturoAssignments.$inferInsert)[] = [
    ...[...sugo.entries()].filter(([, teacherId]) => !manuallySeated.has(teacherId)).map(([seat, teacherId]) => ({ weekId, teacherId, magType: "SUGO", seat, assignmentSource: "AUTO", assignedAt: now, assignedBy: user?.userId ?? null })),
    ...[...reserba.entries()].filter(([, teacherId]) => !manuallySeated.has(teacherId)).map(([seat, teacherId]) => ({ weekId, teacherId, magType: "RESERBA", seat, assignmentSource: "AUTO", assignedAt: now, assignedBy: user?.userId ?? null })),
  ];
  if (new Set(values.map((value) => value.teacherId)).size !== values.length ||
      values.some((value) => manuallySeated.has(value.teacherId))) {
    return { weekId, ...resultWeek, detail, created: 0, skipped: true, reason: "Magtuturo assignments conflict; no assignments changed." };
  }
  if (values.length > 0) await tx.insert(magtuturoAssignments).values(values);
  await audit({
    user,
    action: "MAGTUTURO_GENERATED",
    entityType: "magtuturo_assignments",
    entityId: weekId,
    oldValue: { previousAutoAssignments: previousAuto },
    newValue: {
      sugo: sugo.size,
      reserba: reserba.size,
      carried: keepSugo.length,
      promoted: promote.length,
      rotationCandidates: rotationCandidateCount,
      preservedManual: manualRows.length,
    },
  }, tx);
  return { weekId, ...resultWeek, detail, created: values.length, skipped: false };
}

/** Weekly generation: the same 4+2 algorithm, serialized and audited atomically. */
export async function generateMagtuturoWeek(weekId: string, user: MagUser): Promise<GenerateResult> {
  return withTransaction((tx) => generateMagtuturoWeekInTransaction(tx as Database, weekId, user, { preserveManual: true }));
}

/** Gregorian-month -> every overlapping ISO week, in calendar order. */
export function weeksOverlappingMonth(year: number, month: number): { year: number; week: number; startDate: string; endDate: string }[] {
  if (
    !Number.isInteger(year) || year < 1900 || year > 2999 ||
    !Number.isInteger(month) || month < 1 || month > 12
  ) {
    throw new Error("Invalid Magtuturo month/year");
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  const firstMonday = new Date(first);
  firstMonday.setUTCDate(firstMonday.getUTCDate() - ((firstMonday.getUTCDay() + 6) % 7));
  const result: { year: number; week: number; startDate: string; endDate: string }[] = [];
  for (const monday = firstMonday; monday <= last; monday.setUTCDate(monday.getUTCDate() + 7)) {
    const identity = isoWeek(monday);
    const dates = isoWeekDates(identity.year, identity.week);
    result.push({ ...identity, ...dates });
  }
  return result;
}

async function ensureWeekInTransaction(
  tx: Database,
  target: { year: number; week: number; startDate: string; endDate: string },
) {
  const existing = await tx.select().from(weeks)
    .where(and(eq(weeks.year, target.year), eq(weeks.isoWeekNumber, target.week))).limit(1);
  if (existing[0]) return existing[0];
  const inserted = await tx.insert(weeks).values({
    year: target.year,
    isoWeekNumber: target.week,
    startDate: target.startDate,
    endDate: target.endDate,
    status: "DRAFT",
  }).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
  const raced = await tx.select().from(weeks)
    .where(and(eq(weeks.year, target.year), eq(weeks.isoWeekNumber, target.week))).limit(1);
  if (!raced[0]) throw new Error("Magtuturo month week could not be initialized");
  return raced[0];
}

/**
 * Monthly generation covers every ISO week touching the Gregorian month and
 * runs the regular generator week-by-week only for empty DRAFT weeks. Populated
 * and locked weeks are reported as skips to protect historical/manual records.
 */
export async function generateMagtuturoMonth(
  year: number,
  month: number,
  user: MagUser,
): Promise<MonthlyGenerateResult> {
  const targets = weeksOverlappingMonth(year, month);
  const results: GenerateResult[] = [];
  for (const target of targets) {
    const week = await withTransaction((tx) => ensureWeekInTransaction(tx as Database, target));
    const existing = await getDb().select({ id: magtuturoAssignments.id })
      .from(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, week.id)).limit(1);
    if (week.status !== "DRAFT") {
      results.push({ weekId: week.id, year: week.year, isoWeekNumber: week.isoWeekNumber, detail: [], created: 0, skipped: true, reason: `week is ${week.status} — generation is DRAFT-only` });
    } else if (existing.length > 0) {
      results.push({ weekId: week.id, year: week.year, isoWeekNumber: week.isoWeekNumber, detail: [], created: 0, skipped: true, reason: "week already has Magtuturo assignments" });
    } else {
      results.push(await withTransaction((tx) => generateMagtuturoWeekInTransaction(tx as Database, week.id, user, { preserveManual: false, onlyIfEmpty: true })));
    }
  }
  return { weeks: results, created: results.reduce((total, result) => total + result.created, 0), year, month };
}

/** One batched read from the standalone Magtuturo assignments table. */
export async function listMagtuturoForYear(year: number): Promise<MagtuturoHistoryRow[]> {
  const rows = await getDb()
    .select({
      id: magtuturoAssignments.id,
      weekId: magtuturoAssignments.weekId,
      teacherId: magtuturoAssignments.teacherId,
      teacherCode: teachers.teacherCode,
      firstName: teachers.firstName,
      middleName: teachers.middleName,
      lastName: teachers.lastName,
      suffix: teachers.suffix,
      magType: magtuturoAssignments.magType,
      seat: magtuturoAssignments.seat,
      assignmentSource: magtuturoAssignments.assignmentSource,
      isOverride: magtuturoAssignments.isOverride,
      overrideReason: magtuturoAssignments.overrideReason,
      year: weeks.year,
      isoWeekNumber: weeks.isoWeekNumber,
    })
    .from(magtuturoAssignments)
    .innerJoin(weeks, eq(magtuturoAssignments.weekId, weeks.id))
    .innerJoin(teachers, eq(magtuturoAssignments.teacherId, teachers.id))
    .where(eq(weeks.year, year))
    .orderBy(weeks.isoWeekNumber, magtuturoAssignments.magType, magtuturoAssignments.seat);
  return rows.map((row) => ({
    ...row,
    teacherName: formatFullName(row),
    magType: row.magType as MagType,
  }));
}

function nextFreeSeat(existing: Array<{ magType: string; seat: number }>, magType: MagType): number | null {
  const used = new Set(existing.filter((r) => r.magType === magType).map((r) => r.seat));
  for (let s = 1; s <= MAG_SEATS[magType]; s++) if (!used.has(s)) return s;
  return null;
}

export type AssignMagResult =
  | { ok: true; row: MagtuturoWeekRow }
  | { ok: false; reason: string; violatedRules: string[] };

/**
 * Manual assignment/replacement (21.10) — hard rules are validated here
 * (master INACTIVE, INACTIVE_WEEKLY, English-Dako, oath date). ABSENT teachers
 * remain assignable (21.3). PUBLISHED weeks stay locked (lifecycle).
 */
export async function assignMagtuturo(input: {
  weekId: string;
  teacherId: string;
  magType: MagType;
  seat?: number;
  user: MagUser;
  reason?: string | null;
  isOverride?: boolean;
}): Promise<AssignMagResult> {
  if (!MAG_TYPES.includes(input.magType)) {
    return { ok: false, reason: "Invalid Magtuturo role", violatedRules: [] };
  }

  return withTransaction(async (tx) => {
    const weekRows = await tx.select().from(weeks).where(eq(weeks.id, input.weekId)).for("update").limit(1);
    const week = weekRows[0];
    if (!week) return { ok: false, reason: "Week not found", violatedRules: [] };
    if (week.status === "PUBLISHED") {
      return { ok: false, reason: "Week is PUBLISHED — unlock first", violatedRules: ["WEEK_PUBLISHED"] };
    }

    const [weekly, english, teacherRows, existing] = await Promise.all([
      weeklyStatuses(input.weekId, tx),
      englishDakoTeacherIds(input.weekId, tx),
      tx.select().from(teachers).where(eq(teachers.id, input.teacherId)).limit(1),
      tx.select().from(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, input.weekId)),
    ]);
    const teacher = teacherRows[0];
    if (!teacher) return { ok: false, reason: "Teacher not found", violatedRules: [] };

    const violations = magtuturoViolations(
      teacher as unknown as TeacherCore,
      weekly.get(input.teacherId),
      english.has(input.teacherId),
      week.endDate,
    );
    if (violations.length > 0) {
      return { ok: false, reason: "Teacher fails Magtuturo eligibility (21.6-21.8)", violatedRules: violations };
    }

    const seat = input.seat ?? nextFreeSeat(existing, input.magType);
    if (seat === null) {
      return { ok: false, reason: `All ${MAG_SEATS[input.magType]} ${input.magType} seats are filled`, violatedRules: [] };
    }
    if (!Number.isInteger(seat) || seat < 1 || seat > MAG_SEATS[input.magType]) {
      return { ok: false, reason: `Invalid ${input.magType} seat`, violatedRules: [] };
    }

    const seatedElsewhere = existing.find(
      (row) => row.teacherId === input.teacherId &&
        !(row.magType === input.magType && row.seat === seat),
    );
    if (seatedElsewhere) {
      return {
        ok: false,
        reason: "Teacher is already assigned to another Magtuturo seat this week",
        violatedRules: ["ALREADY_ASSIGNED_MAGTUTURO"],
      };
    }

    const currentSeat = existing.find((row) => row.magType === input.magType && row.seat === seat);
    if (currentSeat?.teacherId === input.teacherId) {
      return {
        ok: true,
        row: {
          id: currentSeat.id,
          weekId: currentSeat.weekId,
          teacherId: currentSeat.teacherId,
          teacherName: formatFullName(teacher),
          teacherCode: teacher.teacherCode,
          magType: currentSeat.magType as MagType,
          seat: currentSeat.seat,
          assignmentSource: currentSeat.assignmentSource,
          isOverride: currentSeat.isOverride,
          overrideReason: currentSeat.overrideReason,
        },
      };
    }

    if (currentSeat) {
      await tx.delete(magtuturoAssignments).where(eq(magtuturoAssignments.id, currentSeat.id));
    }
    const inserted = await tx.insert(magtuturoAssignments).values({
      weekId: input.weekId,
      teacherId: input.teacherId,
      magType: input.magType,
      seat,
      assignmentSource: input.isOverride ? "OVERRIDE" : "MANUAL",
      isOverride: input.isOverride ?? false,
      overrideReason: input.reason ?? null,
      assignedAt: new Date(),
      assignedBy: input.user?.userId ?? null,
    }).returning();
    const saved = inserted[0]!;
    const row: MagtuturoWeekRow = {
      id: saved.id,
      weekId: saved.weekId,
      teacherId: saved.teacherId,
      teacherName: formatFullName(teacher),
      teacherCode: teacher.teacherCode,
      magType: saved.magType as MagType,
      seat: saved.seat,
      assignmentSource: saved.assignmentSource,
      isOverride: saved.isOverride,
      overrideReason: saved.overrideReason,
    };
    await audit({
      user: input.user,
      action: "MAGTUTURO_ASSIGNED",
      entityType: "magtuturo_assignments",
      entityId: input.weekId,
      oldValue: currentSeat ?? null,
      newValue: row,
      reason: input.reason ?? null,
    }, tx);
    return { ok: true, row };
  });
}

/** Clear one Magtuturo seat (audited). */
export async function clearMagtuturo(input: {
  weekId: string; magType: MagType; seat: number; user: MagUser; reason?: string | null;
}): Promise<void> {
  if (!MAG_TYPES.includes(input.magType) || !Number.isInteger(input.seat) || input.seat < 1 || input.seat > MAG_SEATS[input.magType]) {
    throw new Error("Invalid Magtuturo role or seat");
  }
  await withTransaction(async (tx) => {
    const weekRows = await tx.select().from(weeks).where(eq(weeks.id, input.weekId)).for("update").limit(1);
    const week = weekRows[0];
    if (!week) throw new Error("Week not found");
    if (week.status === "PUBLISHED") throw new Error("Week is PUBLISHED — unlock first");
    const deleted = await tx.delete(magtuturoAssignments).where(and(
      eq(magtuturoAssignments.weekId, input.weekId),
      eq(magtuturoAssignments.magType, input.magType),
      eq(magtuturoAssignments.seat, input.seat),
    )).returning();
    await audit({
      user: input.user,
      action: "MAGTUTURO_CLEARED",
      entityType: "magtuturo_assignments",
      entityId: input.weekId,
      oldValue: deleted[0] ?? { magType: input.magType, seat: input.seat },
      reason: input.reason ?? null,
    }, tx);
  });
}

/** All Magtuturo rows for a week (4 SUGO + 2 RESERBA), names per Update #3. */
export async function listMagtuturoForWeek(weekId: string): Promise<MagtuturoWeekRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: magtuturoAssignments.id,
      weekId: magtuturoAssignments.weekId,
      teacherId: magtuturoAssignments.teacherId,
      magType: magtuturoAssignments.magType,
      seat: magtuturoAssignments.seat,
      assignmentSource: magtuturoAssignments.assignmentSource,
      isOverride: magtuturoAssignments.isOverride,
      overrideReason: magtuturoAssignments.overrideReason,
      teacherCode: teachers.teacherCode,
      firstName: teachers.firstName,
      middleName: teachers.middleName,
      lastName: teachers.lastName,
      suffix: teachers.suffix,
    })
    .from(magtuturoAssignments)
    .innerJoin(teachers, eq(magtuturoAssignments.teacherId, teachers.id))
    .where(eq(magtuturoAssignments.weekId, weekId))
    .orderBy(asc(magtuturoAssignments.seat));
  return rows.map((r) => ({
    id: r.id,
    weekId: r.weekId,
    teacherId: r.teacherId,
    teacherName: formatFullName({ firstName: r.firstName, middleName: r.middleName, lastName: r.lastName, suffix: r.suffix }),
    teacherCode: r.teacherCode,
    magType: r.magType as MagType,
    seat: r.seat,
    assignmentSource: r.assignmentSource,
    isOverride: r.isOverride,
    overrideReason: r.overrideReason,
  }));
}
