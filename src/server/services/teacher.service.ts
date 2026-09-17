import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { teachers, dako } from "@/server/db/schema";
import { teacherCreateSchema, teacherUpdateSchema, type TeacherCreateInput } from "@/lib/validation/schemas";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { audit, type AuditEntry } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";
import { calculateAge, elapsedSince } from "@/lib/anniversary";

export async function createTeacher(
  input: TeacherCreateInput,
  actor: SessionUser,
): Promise<typeof teachers.$inferSelect> {
  teacherCreateSchema.parse(input);
  return withTransaction(async (tx) => {
    if (input.currentDestinationId) {
      const dest = await tx.select().from(dako).where(eq(dako.id, input.currentDestinationId)).limit(1);
      const target = dest[0];
      if (!target) throw new ValidationError("currentDestinationId does not reference a valid dako");
      if (target.status !== "ACTIVE") {
        throw new ValidationError("only ACTIVE dako can be selected as Current Destination");
      }
    }
    try {
      // Phase 6 §20-§21: concurrency-safe auto code when omitted (UI never
      // sends one). nextval INSIDE the transaction — simultaneous creates
      // never collide; gaps from rollbacks are permanent (no reuse).
      let teacherCode = input.teacherCode;
      if (!teacherCode) {
        const n = await tx.execute(sql`select nextval('pnk_teacher_code_seq') as nextval`);
        teacherCode = `PNK-G-${n[0]!.nextval}`;
      }
      const inserted = await tx.insert(teachers).values({ ...input, teacherCode }).returning();
      const row = inserted[0]!;
      await audit(
        { user: actor, action: "CREATED_TEACHER", entityType: "teacher", entityId: row.id, newValue: row },
        tx as Database,
      );
      return row;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictError("teacher_code already exists");
      throw err;
    }
  });
}

export async function updateTeacher(
  id: string,
  input: unknown,
  actor: SessionUser,
): Promise<typeof teachers.$inferSelect> {
  const patch = teacherUpdateSchema.parse(input);
  return withTransaction(async (tx) => {
    const before = await tx.select().from(teachers).where(eq(teachers.id, id)).limit(1);
    if (before.length === 0) throw new NotFoundError("teacher not found");
    if (patch.currentDestinationId) {
      const dest = await tx.select().from(dako).where(eq(dako.id, patch.currentDestinationId)).limit(1);
      const target = dest[0];
      if (!target) throw new ValidationError("currentDestinationId does not reference a valid dako");
      if (target.status !== "ACTIVE") {
        throw new ValidationError("only ACTIVE dako can be selected as Current Destination");
      }
    }
    try {
      const updated = await tx.update(teachers).set(patch).where(eq(teachers.id, id)).returning();
      const row = updated[0]!;
      await audit(
        { user: actor, action: "UPDATED_TEACHER", entityType: "teacher", entityId: id, oldValue: before[0], newValue: row },
        tx as Database,
      );
      return row;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictError("teacher_code already exists");
      throw err;
    }
  });
}

/** Soft deactivation (§14): keeps the record; requires a reason; stamps date_inactive. */
export async function deactivateTeacher(
  id: string,
  inactiveReason: string,
  actor: SessionUser,
): Promise<typeof teachers.$inferSelect> {
  if (!inactiveReason.trim()) throw new ValidationError("inactive reason is required");
  return withTransaction(async (tx) => {
    const before = await tx.select().from(teachers).where(eq(teachers.id, id)).limit(1);
    const prior = before[0];
    if (!prior) throw new NotFoundError("teacher not found");
    if (prior.status === "INACTIVE") throw new ConflictError("teacher already inactive");
    const updated = await tx
      .update(teachers)
      .set({ status: "INACTIVE", dateInactive: todayISO(), inactiveReason })
      .where(eq(teachers.id, id))
      .returning();
    const row = updated[0]!;
    await audit(
      { user: actor, action: "DEACTIVATED_TEACHER", entityType: "teacher", entityId: id, oldValue: before[0], newValue: row, reason: inactiveReason },
      tx as Database,
    );
    return row;
  });
}

export async function reactivateTeacher(id: string, actor: SessionUser): Promise<typeof teachers.$inferSelect> {
  return withTransaction(async (tx) => {
    const before = await tx.select().from(teachers).where(eq(teachers.id, id)).limit(1);
    const prior = before[0];
    if (!prior) throw new NotFoundError("teacher not found");
    if (prior.status === "ACTIVE") throw new ConflictError("teacher already active");
    const updated = await tx
      .update(teachers)
      .set({ status: "ACTIVE", dateInactive: null, inactiveReason: null })
      .where(eq(teachers.id, id))
      .returning();
    const row = updated[0]!;
    await audit(
      { user: actor, action: "REACTIVATED_TEACHER", entityType: "teacher", entityId: id, oldValue: prior, newValue: row },
      tx as Database,
    );
    return row;
  });
}

export async function getTeacher(id: string) {
  const rows = await getDb().select().from(teachers).where(eq(teachers.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("teacher not found");
  return rows[0];
}

export type TeacherSortField = "code" | "name" | "birthday" | "status" | "dateOfOath";

export interface TeacherListOptions {
  status?: "ACTIVE" | "INACTIVE";
  language?: string;
  currentDestinationId?: string;
  search?: string;
  sort?: TeacherSortField;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface TeacherListRow {
  id: string;
  teacherCode: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  birthday: string | null;
  purokGrupo: string | null;
  language: string;
  status: string;
  dateOfOath: string | null;
  currentDestinationId: string | null;
  currentDestinationName: string | null;
  currentDestinationStatus: string | null;
}

/**
 * §2 Teacher list: search (code/first/middle/last/full name), filters limited to
 * Status / Language / Current Destination (purok/grupo deliberately NOT a filter),
 * whitelisted sorts (age sorts via birthday — age is derived), pagination.
 */
export async function listTeachers(opts: TeacherListOptions = {}): Promise<{ rows: TeacherListRow[]; total: number; page: number; pageCount: number }> {
  const conds = [];
  if (opts.status) conds.push(eq(teachers.status, opts.status));
  if (opts.language) conds.push(eq(teachers.language, opts.language));
  if (opts.currentDestinationId) conds.push(eq(teachers.currentDestinationId, opts.currentDestinationId));
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    conds.push(
      or(
        ilike(teachers.teacherCode, term),
        ilike(teachers.firstName, term),
        ilike(teachers.middleName, term),
        ilike(teachers.lastName, term),
        ilike(sql`concat_ws(' ', ${teachers.firstName}, ${teachers.middleName}, ${teachers.lastName})`, term),
      ),
    );
  }
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const sortCol = {
    code: teachers.teacherCode,
    name: teachers.lastName,
    birthday: teachers.birthday,
    status: teachers.status,
    dateOfOath: teachers.dateOfOath,
  }[opts.sort ?? "name"];
  const dir = opts.order === "desc" ? desc : asc;

  const rows = await getDb()
    .select({
      id: teachers.id,
      teacherCode: teachers.teacherCode,
      firstName: teachers.firstName,
      middleName: teachers.middleName,
      lastName: teachers.lastName,
      birthday: teachers.birthday,
      purokGrupo: teachers.purokGrupo,
      language: teachers.language,
      status: teachers.status,
      dateOfOath: teachers.dateOfOath,
      currentDestinationId: teachers.currentDestinationId,
      currentDestinationName: dako.name,
      currentDestinationStatus: dako.status,
    })
    .from(teachers)
    .leftJoin(dako, eq(dako.id, teachers.currentDestinationId))
    .where(whereClause)
    .orderBy(dir(sortCol))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const countRows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(teachers)
    .where(whereClause);
  const total = countRows[0]?.n ?? 0;

  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function countActiveTeachers(): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(teachers)
    .where(eq(teachers.status, "ACTIVE"));
  return rows[0]?.n ?? 0;
}

export interface ChangeDestinationResult {
  teacher: typeof teachers.$inferSelect;
  previousDestinationId: string | null;
}

/**
 * §7 Current Destination change: reference-level only. Touches nothing else —
 * no assignments, no history, no availability. Audited with reason.
 */
export async function changeCurrentDestination(
  teacherId: string,
  newDestinationId: string | null,
  reason: string,
  actor: SessionUser,
): Promise<ChangeDestinationResult> {
  if (!reason.trim()) throw new ValidationError("reason is required to change Current Destination");
  return withTransaction(async (tx) => {
    const before = await tx.select().from(teachers).where(eq(teachers.id, teacherId)).limit(1);
    const teacher = before[0];
    if (!teacher) throw new NotFoundError("teacher not found");

    if (newDestinationId) {
      const d = await tx.select().from(dako).where(eq(dako.id, newDestinationId)).limit(1);
      const target = d[0];
      if (!target) throw new ValidationError("new destination does not reference a valid dako");
      if (target.status !== "ACTIVE") {
        throw new ValidationError("only ACTIVE dako can be selected as Current Destination");
      }
    }

    const updated = await tx
      .update(teachers)
      .set({ currentDestinationId: newDestinationId })
      .where(eq(teachers.id, teacherId))
      .returning();
    const row = updated[0]!;

    await audit(
      {
        user: actor,
        action: "CHANGED_CURRENT_DESTINATION",
        entityType: "teacher",
        entityId: teacherId,
        oldValue: { currentDestinationId: teacher.currentDestinationId },
        newValue: { currentDestinationId: newDestinationId },
        reason,
      },
      tx as Database,
    );

    return { teacher: row, previousDestinationId: teacher.currentDestinationId };
  });
}

export interface TeacherDetails {
  teacher: typeof teachers.$inferSelect;
  currentDestination: { id: string; name: string; status: string } | null;
  age: number | null;
  inactiveFor: { years: number; months: number } | null;
}

/** §3 Teacher details with computed displays. */
export async function getTeacherDetails(id: string): Promise<TeacherDetails> {
  const teacher = await getTeacher(id);
  let currentDestination: TeacherDetails["currentDestination"] = null;
  if (teacher.currentDestinationId) {
    const d = await getDb()
      .select({ id: dako.id, name: dako.name, status: dako.status })
      .from(dako)
      .where(eq(dako.id, teacher.currentDestinationId))
      .limit(1);
    currentDestination = d[0] ?? null;
  }
  const age = teacher.birthday ? calculateAge(teacher.birthday) : null;
  const inactiveFor = teacher.status === "INACTIVE" && teacher.dateInactive ? elapsedSince(teacher.dateInactive) : null;
  return { teacher, currentDestination, age, inactiveFor };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Drizzle wraps driver errors; walk the cause chain to find postgres 23505. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e instanceof Error || (typeof e === "object" && e !== null)) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
    if (e === undefined || e === null) break;
  }
  return false;
}

export type { AuditEntry };
