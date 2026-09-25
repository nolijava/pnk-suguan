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
 * Guro Duty extension (Destinado / Katuwang): teaching seats go to eligible
 * KATUWANG first, drawn from the per-dako duty rosters (Current Destination)
 * with a fair rotation that is tracked WITHIN each dako (least-loaded, then
 * longest-idle, then teacherCode) and interleaved ACROSS dakos (round-robin),
 * so one dako's roster can never monopolise the week-level seats. Continuity
 * (21.4/21.5) still comes first, and seats not covered by Katuwang fall back
 * to the original global fair rotation — legacy teachers without a recorded
 * duty are never excluded from this category.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import {
  assignments,
  dako,
  magtuturoAssignments,
  teacherAvailability,
  teachers,
  weeks,
} from "@/server/db/schema";
import { formatFullName } from "@/lib/name";
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
  /** Guro Duty — 'DESTINADO' | 'KATUWANG'; null = none recorded. */
  duty: string | null;
  /** The teacher's Current Destination dako (their duty roster). */
  currentDestinationId: string | null;
}

/** Per-teacher Magtuturo rotation stats (all-time, from past seats). */
type RotationRank = Map<string, { count: number; last: number }>;

/**
 * Pure round-robin interleave of the per-dako candidate queues: level 0 of
 * every dako first, then level 1, … — fair share ACROSS dakos while each queue
 * already carries its own within-dako fair rotation. Deterministic: the caller
 * supplies the queues in dako order.
 */
export function roundRobinByDako(queues: string[][]): string[] {
  const out: string[] = [];
  const max = queues.reduce((n, q) => Math.max(n, q.length), 0);
  for (let level = 0; level < max; level++) {
    for (const q of queues) {
      const id = q[level];
      if (id !== undefined) out.push(id);
    }
  }
  return out;
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
  const weekly = await weeklyStatuses(weekId);
  const english = await englishDakoTeacherIds(weekId);
  const all = (await db.select().from(teachers)) as TeacherCore[];
  return all.map((t) => {
    const violated = magtuturoViolations(t, weekly.get(t.id), english.has(t.id), week.endDate);
    return {
      teacherId: t.id,
      teacherName: formatFullName(t),
      eligible: violated.length === 0,
      violatedRules: violated,
    };
  });
}

async function getWeek(weekId: string) {
  const db = getDb();
  const [week] = await db.select().from(weeks).where(eq(weeks.id, weekId));
  if (!week) throw new Error("Week not found");
  return week;
}

async function weeklyStatuses(weekId: string): Promise<Map<string, string>> {
  const db = getDb();
  const rows = await db.select().from(teacherAvailability).where(eq(teacherAvailability.weekId, weekId));
  return new Map(rows.map((r: typeof teacherAvailability.$inferSelect) => [r.teacherId, r.availabilityStatus]));
}

/** Teachers assigned to an ENGLISH dako this week (21.6 hard exclusion). */
async function englishDakoTeacherIds(weekId: string): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ teacherId: assignments.teacherId })
    .from(assignments)
    .innerJoin(dako, eq(assignments.dakoId, dako.id))
    .where(and(eq(assignments.weekId, weekId), eq(dako.language, "ENGLISH")));
  return new Set(rows.map((r: { teacherId: string }) => r.teacherId));
}

/** The ISO week before this one — handles year transitions. */
async function priorWeek(week: { id: string; year: number; isoWeekNumber: number }) {
  const db = getDb();
  const candidates = await db.select().from(weeks).where(inArray(weeks.year, [week.year - 1, week.year]));
  const before = candidates
    .filter((w: typeof weeks.$inferSelect) => w.id !== week.id && (w.year < week.year || (w.year === week.year && w.isoWeekNumber < week.isoWeekNumber)))
    .sort((a: typeof weeks.$inferSelect, b: typeof weeks.$inferSelect) => b.year - a.year || b.isoWeekNumber - a.isoWeekNumber);
  return before[0] ?? null;
}

/** Fair rotation (21.2): least-loaded first, then longest since last seat. */
async function rotationRank(): Promise<Map<string, { count: number; last: number }>> {
  const db = getDb();
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
  detail: string[];
  created: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Weekly generation (21.9): 4 SUGO + 2 RESERBA. Continuity (21.4/21.5) takes
 * SUGO seats first, fair rotation fills the rest. DRAFT weeks only (lifecycle).
 */
export async function generateMagtuturoWeek(weekId: string, user: MagUser): Promise<GenerateResult> {
  const db = getDb();
  const week = await getWeek(weekId);
  if (week.status !== "DRAFT") {
    return { weekId, detail: [], created: 0, skipped: true, reason: `week is ${week.status} — generation is DRAFT-only` };
  }
  const detail: string[] = [];
  const weekly = await weeklyStatuses(weekId);
  const english = await englishDakoTeacherIds(weekId);
  const all = (await db.select().from(teachers)) as unknown as TeacherCore[];

  const eligible = new Map<string, TeacherCore>();
  for (const t of all) {
    if (magtuturoViolations(t, weekly.get(t.id), english.has(t.id), week.endDate).length === 0) eligible.set(t.id, t);
  }

  // 21.4/21.5 continuity from the previous week.
  const keepSugo: string[] = [];
  const promote: string[] = [];
  const prev = await priorWeek(week);
  if (prev) {
    const prevRows = await db.select().from(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, prev.id));
    const ordered = [...prevRows].sort((x, y) => x.seat - y.seat);
    for (const p of ordered) {
      if (!eligible.has(p.teacherId)) continue; // hard rules win (21.8)
      const absentNow = weekly.get(p.teacherId) === "ABSENT";
      if (p.magType === "SUGO" && absentNow) keepSugo.push(p.teacherId); // 21.4
      if (p.magType === "RESERBA" && !absentNow) promote.push(p.teacherId); // 21.5
    }
    if (keepSugo.length) detail.push(`21.4 SUGO continuity: ${keepSugo.length} carried over (absent)`);
    if (promote.length) detail.push(`21.5 RESERBA progression: ${promote.length} promoted to SUGO`);
  }

  // fair rotation fills remaining SUGO first, then RESERBA (21.2/21.9).
  const rank = await rotationRank();
  const taken = new Set<string>();
  const sugoSeats: string[] = [];
  for (const id of [...keepSugo, ...promote]) {
    if (!taken.has(id)) { sugoSeats.push(id); taken.add(id); }
  }

  // Guro Duty roster extension: eligible KATUWANG take the teaching seats
  // first, grouped by their Current Destination dako. Within a dako the
  // least-loaded / longest-idle Katuwang comes first; the per-dako queues are
  // then interleaved so every dako's roster gets a fair share.
  const dakoRows = await db.select().from(dako);
  const byServes = (a: { id: string; code: string }, b: { id: string; code: string }) => {
    const ra = rank.get(a.id) ?? { count: 0, last: 0 };
    const rb = rank.get(b.id) ?? { count: 0, last: 0 };
    return ra.count - rb.count || rb.last - ra.last || a.code.localeCompare(b.code);
  };
  const katByDako = new Map<string, { id: string; code: string }[]>();
  const fallbackIds: string[] = []; // duty-less / Destinado / roster-less teachers
  for (const t of all) {
    if (taken.has(t.id) || !eligible.has(t.id)) continue;
    if (t.duty === "KATUWANG" && t.currentDestinationId) {
      const list = katByDako.get(t.currentDestinationId) ?? [];
      list.push({ id: t.id, code: t.teacherCode });
      katByDako.set(t.currentDestinationId, list);
    } else {
      fallbackIds.push(t.id);
    }
  }
  const dakoCodeOf = (id: string) => dakoRows.find((d) => d.id === id)?.dakoCode ?? id;
  const queues = [...katByDako.entries()]
    .sort(([a], [b]) => dakoCodeOf(a).localeCompare(dakoCodeOf(b)))
    .map(([, members]) => members.sort(byServes).map((m) => m.id));
  const katPool = roundRobinByDako(queues);
  if (katPool.length) {
    detail.push(
      `Duty roster: ${katPool.length} eligible Katuwang from ${queues.length} dako(s) in fair rotation`,
    );
  }
  // Fallback keeps the ORIGINAL global fair rotation — identical behavior for
  // rosters without recorded duty.
  const pool = [
    ...katPool,
    ...fallbackIds.sort((a, b) => {
      const ra = rank.get(a) ?? { count: 0, last: 0 };
      const rb = rank.get(b) ?? { count: 0, last: 0 };
      return ra.count - rb.count || rb.last - ra.last || a.localeCompare(b);
    }),
  ];
  while (sugoSeats.length < MAG_SEATS.SUGO && pool.length) {
    const id = pool.shift()!;
    sugoSeats.push(id);
    taken.add(id);
  }
  const reserbaSeats: string[] = [];
  while (reserbaSeats.length < MAG_SEATS.RESERBA && pool.length) {
    const id = pool.shift()!;
    reserbaSeats.push(id);
    taken.add(id);
  }

  // Replace the week's rows (idempotent regeneration; DRAFT-only enforced above).
  await db.delete(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, weekId));
  const now = new Date();
  const values: (typeof magtuturoAssignments.$inferInsert)[] = [
    ...sugoSeats.map((teacherId, i) => ({ weekId, teacherId, magType: "SUGO", seat: i + 1, assignmentSource: "AUTO", assignedAt: now, assignedBy: user?.userId ?? null })),
    ...reserbaSeats.map((teacherId, i) => ({ weekId, teacherId, magType: "RESERBA", seat: i + 1, assignmentSource: "AUTO", assignedAt: now, assignedBy: user?.userId ?? null })),
  ];
  if (values.length) await db.insert(magtuturoAssignments).values(values);
  await audit({
    user,
    action: "MAGTUTURO_GENERATED",
    entityType: "magtuturo_assignments",
    entityId: weekId,
    newValue: {
      sugo: sugoSeats.length,
      reserba: reserbaSeats.length,
      carried: keepSugo.length,
      promoted: promote.length,
      katuwang: katPool.length,
      fallback: fallbackIds.length,
    },
  });
  return { weekId, detail, created: values.length, skipped: false };
}

/** Monthly generation (21.11) — the underlying weeks are generated week by week. */
export async function generateMagtuturoMonth(
  year: number,
  month: number,
  user: MagUser,
): Promise<{ weeks: GenerateResult[]; created: number }> {
  const db = getDb();
  const all = await db.select().from(weeks).where(eq(weeks.year, year));
  const target = all
    .filter((w: typeof weeks.$inferSelect) => Number(w.endDate.slice(5, 7)) === month)
    .sort((a: typeof weeks.$inferSelect, b: typeof weeks.$inferSelect) => a.isoWeekNumber - b.isoWeekNumber);
  const results: GenerateResult[] = [];
  for (const w of target) results.push(await generateMagtuturoWeek(w.id, user));
  return { weeks: results, created: results.reduce((n, r) => n + r.created, 0) };
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
  const db = getDb();
  const week = await getWeek(input.weekId);
  if (week.status === "PUBLISHED") return { ok: false, reason: "Week is PUBLISHED — unlock first", violatedRules: ["WEEK_PUBLISHED"] };
  const weekly = await weeklyStatuses(input.weekId);
  const english = await englishDakoTeacherIds(input.weekId);
  const [t] = await db.select().from(teachers).where(eq(teachers.id, input.teacherId));
  if (!t) return { ok: false, reason: "Teacher not found", violatedRules: [] };
  const violated = magtuturoViolations(
    t as unknown as TeacherCore,
    weekly.get(input.teacherId),
    english.has(input.teacherId),
    week.endDate,
  );
  if (violated.length) return { ok: false, reason: "Teacher fails Magtuturo eligibility (21.6-21.8)", violatedRules: violated };

  const existing = await db.select().from(magtuturoAssignments).where(eq(magtuturoAssignments.weekId, input.weekId));
  const seat = input.seat ?? nextFreeSeat(existing, input.magType);
  if (seat === null) return { ok: false, reason: `All ${MAG_SEATS[input.magType]} ${input.magType} seats are filled`, violatedRules: [] };

  // one seat per teacher per week; one teacher per (week, type, seat).
  await db.delete(magtuturoAssignments).where(and(
    eq(magtuturoAssignments.weekId, input.weekId),
    eq(magtuturoAssignments.teacherId, input.teacherId),
  ));
  await db.delete(magtuturoAssignments).where(and(
    eq(magtuturoAssignments.weekId, input.weekId),
    eq(magtuturoAssignments.magType, input.magType),
    eq(magtuturoAssignments.seat, seat),
  ));
  await db.insert(magtuturoAssignments).values({
    weekId: input.weekId,
    teacherId: input.teacherId,
    magType: input.magType,
    seat,
    assignmentSource: input.isOverride ? "OVERRIDE" : "MANUAL",
    isOverride: input.isOverride ?? false,
    overrideReason: input.reason ?? null,
    assignedAt: new Date(),
    assignedBy: input.user?.userId ?? null,
  });
  await audit({
    user: input.user,
    action: "MAGTUTURO_ASSIGNED",
    entityType: "magtuturo_assignments",
    entityId: input.weekId,
    newValue: { teacherId: input.teacherId, magType: input.magType, seat },
    reason: input.reason ?? null,
  });
  const rows = await listMagtuturoForWeek(input.weekId);
  const row = rows.find((r) => r.magType === input.magType && r.seat === seat)!;
  return { ok: true, row };
}

/** Clear one Magtuturo seat (audited). */
export async function clearMagtuturo(input: {
  weekId: string; magType: MagType; seat: number; user: MagUser; reason?: string | null;
}): Promise<void> {
  const db = getDb();
  const week = await getWeek(input.weekId);
  if (week.status === "PUBLISHED") throw new Error("Week is PUBLISHED — unlock first");
  await db.delete(magtuturoAssignments).where(and(
    eq(magtuturoAssignments.weekId, input.weekId),
    eq(magtuturoAssignments.magType, input.magType),
    eq(magtuturoAssignments.seat, input.seat),
  ));
  await audit({
    user: input.user,
    action: "MAGTUTURO_CLEARED",
    entityType: "magtuturo_assignments",
    entityId: input.weekId,
    oldValue: { magType: input.magType, seat: input.seat },
    reason: input.reason ?? null,
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
