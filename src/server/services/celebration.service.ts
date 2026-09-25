/**
 * Update #1/#2 — Guro birthday and oath-anniversary (Panunumpa) notices.
 *
 * Read paths are pure SELECTs over the EXISTING teacher master data; stored
 * birthday/oath-taking dates are never modified (Update #2). Notice writes are
 * idempotent through the 0011 dedupe tables:
 *   - birthdays:  (teacher x birthday year x stage)   — individual notices
 *   - anniversaries: (month-day x year x stage)       — ONE combined notice per
 *                 date, listing every teacher sharing that anniversary date.
 * Notices fan out to active users who hold `notifications.read` (the existing
 * bell audience). No scheduling data is touched.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import {
  teachers,
  users,
  userRoles,
  roles,
  notifications,
  teacherBirthdayNotifications,
  teacherAnniversaryNotifications,
} from "@/server/db/schema";
import { anniversaryStage, calculateAge, nextAnniversary, type AnniversaryStage } from "@/lib/anniversary";
import { formatFullName } from "@/lib/name";
import { hasPermission } from "@/server/auth/permissions";

interface TeacherCelebrationRow {
  id: string;
  teacherCode: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  birthday: string | null;
  dateOfOath: string | null;
}

function tName(t: Pick<TeacherCelebrationRow, "firstName" | "middleName" | "lastName" | "suffix">): string {
  return formatFullName(t);
}

/** Audience: active users whose roles hold notifications.read (the bell). */
async function recipientIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(users.status, "ACTIVE"));
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    const list = byUser.get(r.id) ?? [];
    list.push(r.code);
    byUser.set(r.id, list);
  }
  return [...byUser.entries()].filter(([, codes]) => hasPermission(codes, "notifications.read")).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Read side — the monthly Celebrant view / Celebrations report (#1/#2)
// ---------------------------------------------------------------------------

export interface BirthdayCelebrant {
  teacherId: string;
  teacherCode: string;
  teacherName: string;
  birthday: string;
  day: number;
  turningAge: number;
}

export interface AnniversaryCelebrant {
  teacherId: string;
  teacherCode: string;
  teacherName: string;
  dateOfOath: string;
  completedYears: number;
}

export interface AnniversaryGroup {
  month: number;
  day: number;
  /** Resolved celebration date (YYYY-MM-DD) of the next occurrence. */
  date: string;
  completedYearsLabel: string;
  teachers: AnniversaryCelebrant[];
}

export interface CelebrationsReport {
  year: number;
  month: number;
  birthdayCelebrants: BirthdayCelebrant[];
  anniversaryGroups: AnniversaryGroup[];
}

/**
 * Monthly birthday celebrant list (#1) — active teachers whose birthday falls
 * in the given calendar month, ordered by day. Ages are derived, never stored.
 */
export async function listMonthlyBirthdayCelebrants(
  year: number,
  month: number,
  now: Date = new Date(),
): Promise<BirthdayCelebrant[]> {
  const rows = (await getDb().select().from(teachers)) as unknown as TeacherCelebrationRow[];
  return rows
    .filter((t) => t.birthday !== null && Number(t.birthday.slice(5, 7)) === month)
    .map((t) => ({
      teacherId: t.id,
      teacherCode: t.teacherCode,
      teacherName: tName(t),
      birthday: t.birthday as string,
      day: Number((t.birthday as string).slice(8, 10)),
      turningAge: now.getUTCFullYear() - Number((t.birthday as string).slice(0, 4)),
    }))
    .sort((a, b) => a.day - b.day || a.teacherName.localeCompare(b.teacherName));
}

/**
 * Oath-anniversary groups (#2) — teachers sharing the same anniversary
 * month-day are ONE group. `completedYears` counts full years since each
 * teacher's Panunumpa date at the next occurrence. Stored dates untouched.
 */
export async function listAnniversaryGroups(now: Date = new Date()): Promise<AnniversaryGroup[]> {
  const rows = (await getDb().select().from(teachers)) as unknown as TeacherCelebrationRow[];
  const groups = new Map<string, AnniversaryGroup & { year: number }>();
  for (const t of rows) {
    if (!t.dateOfOath) continue;
    const next = nextAnniversary(t.dateOfOath, now);
    const m = next.date.getUTCMonth() + 1;
    const d = next.date.getUTCDate();
    const key = `${m}-${d}`;
    const oathYear = Number(t.dateOfOath.slice(0, 4));
    const completedYears = next.anniversaryYear - oathYear;
    const group = groups.get(key) ?? {
      month: m,
      day: d,
      date: next.date.toISOString().slice(0, 10),
      year: next.anniversaryYear,
      completedYearsLabel: "",
      teachers: [],
    };
    group.teachers.push({
      teacherId: t.id,
      teacherCode: t.teacherCode,
      teacherName: tName(t),
      dateOfOath: t.dateOfOath,
      completedYears,
    });
    groups.set(key, group);
  }
  const out = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const g of out) {
    g.teachers.sort((a, b) => a.teacherName.localeCompare(b.teacherName));
    const years = [...new Set(g.teachers.map((t) => t.completedYears))].sort((a, b) => a - b);
    g.completedYearsLabel = years.map((y) => `${y} year${y === 1 ? "" : "s"}`).join(", ");
  }
  return out.map(({ year: _year, ...g }) => g);
}

/** Combined Celebrations report for the monthly view. */
export async function celebrationsReport(
  year: number,
  month: number,
  now: Date = new Date(),
): Promise<CelebrationsReport> {
  const [birthdayCelebrants, anniversaryGroups] = await Promise.all([
    listMonthlyBirthdayCelebrants(year, month, now),
    listAnniversaryGroups(now),
  ]);
  return {
    year,
    month,
    birthdayCelebrants,
    // The monthly view shows anniversary groups falling in the same month.
    anniversaryGroups: anniversaryGroups.filter((g) => g.month === month),
  };
}

// ---------------------------------------------------------------------------
// Write side — idempotent notice creation (dedupe tables from 0011)
// ---------------------------------------------------------------------------

function birthdayTitle(type: string, name: string): string {
  switch (type) {
    case "ONE_MONTH_BEFORE": return `1 month to ${name}'s birthday`;
    case "APPROACHING": return `${name}'s birthday approaching`;
    case "ONE_DAY_BEFORE": return `Tomorrow: ${name}'s birthday`;
    case "TODAY": return `Happy Birthday, ${name}!`;
    default: return `${name}'s birthday`;
  }
}

function birthdayMessage(type: string, name: string): string {
  switch (type) {
    case "ONE_MONTH_BEFORE": return `${name} celebrates a birthday in one month.`;
    case "APPROACHING": return `${name}'s birthday is coming up soon.`;
    case "ONE_DAY_BEFORE": return `${name} celebrates a birthday tomorrow.`;
    case "TODAY": return `Today is ${name}'s birthday!`;
    default: return `${name} birthday notification.`;
  }
}

/** Idempotent individual birthday notice (#1). */
export async function recordTeacherBirthdayNotice(
  teacherId: string,
  birthdayYear: number,
  notificationType: string,
): Promise<{ created: boolean; notifications: number }> {
  const db = getDb();
  const existing = await db
    .select({ id: teacherBirthdayNotifications.id })
    .from(teacherBirthdayNotifications)
    .where(
      and(
        eq(teacherBirthdayNotifications.teacherId, teacherId),
        eq(teacherBirthdayNotifications.birthdayYear, birthdayYear),
        eq(teacherBirthdayNotifications.notificationType, notificationType),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { created: false, notifications: 0 };

  const t = (await db.select().from(teachers).where(eq(teachers.id, teacherId)).limit(1))[0] as
    | TeacherCelebrationRow
    | undefined;
  if (!t) return { created: false, notifications: 0 };
  const name = tName(t);

  const recipients = await recipientIds();
  if (recipients.length === 0) return { created: false, notifications: 0 };

  const count = await db.transaction(async (tx) => {
    await tx
      .insert(teacherBirthdayNotifications)
      .values({ teacherId, birthdayYear, notificationType });
    await tx.insert(notifications).values(
      recipients.map((userId) => ({
        userId,
        notificationType,
        title: birthdayTitle(notificationType, name),
        message: birthdayMessage(notificationType, name),
        relatedEntityType: "teacher",
        relatedEntityId: teacherId,
      })),
    );
    return recipients.length;
  });
  return { created: true, notifications: count };
}

/**
 * Idempotent GROUPED oath-anniversary notice (#2) — ONE notification listing
 * every teacher sharing the anniversary date. Stored oath dates untouched.
 */
export async function recordTeacherAnniversaryGroupNotice(input: {
  month: number;
  day: number;
  anniversaryYear: number;
  notificationType: string;
  teachersInGroup: { teacherId: string; teacherName: string; completedYears: number }[];
}): Promise<{ created: boolean; notifications: number }> {
  const db = getDb();
  const existing = await db
    .select({ id: teacherAnniversaryNotifications.id })
    .from(teacherAnniversaryNotifications)
    .where(
      and(
        eq(teacherAnniversaryNotifications.anniversaryMonth, input.month),
        eq(teacherAnniversaryNotifications.anniversaryDay, input.day),
        eq(teacherAnniversaryNotifications.anniversaryYear, input.anniversaryYear),
        eq(teacherAnniversaryNotifications.notificationType, input.notificationType),
      ),
    )
    .limit(1);
  if (existing.length > 0 || input.teachersInGroup.length === 0) {
    return { created: false, notifications: 0 };
  }

  const recipients = await recipientIds();
  if (recipients.length === 0) return { created: false, notifications: 0 };

  const names = input.teachersInGroup
    .map((t) => `${t.teacherName} (${t.completedYears} year${t.completedYears === 1 ? "" : "s"})`)
    .join(", ");
  const dateLabel = `${String(input.month).padStart(2, "0")}/${String(input.day).padStart(2, "0")}`;
  const [sole] = input.teachersInGroup;
  const title =
    input.teachersInGroup.length === 1 && sole
      ? `Guro Anniversary ${dateLabel} — ${sole.teacherName}`
      : `Guro Anniversary ${dateLabel} — ${input.teachersInGroup.length} teachers`;

  const count = await db.transaction(async (tx) => {
    await tx
      .insert(teacherAnniversaryNotifications)
      .values({
        anniversaryMonth: input.month,
        anniversaryDay: input.day,
        anniversaryYear: input.anniversaryYear,
        notificationType: input.notificationType,
      });
    await tx.insert(notifications).values(
      recipients.map((userId) => ({
        userId,
        notificationType: input.notificationType,
        title,
        message: `Oath-taking anniversary (${dateLabel}/${input.anniversaryYear}): ${names}.`,
        relatedEntityType: "teacher_anniversary_group",
        // A GROUP notice covers several teachers — there is no single entity
        // uuid to point at (and the notification-links layer has no route for
        // this type). related_entity_id IS a uuid column: the old date-based
        // group key (`2026-09/24`) crashed the insert and with it the whole
        // boot-time celebration scan. The group identity lives in
        // teacher_anniversary_notifications (the dedupe row above).
        relatedEntityId: null,
      })),
    );
    return recipients.length;
  });
  return { created: true, notifications: count };
}

// ---------------------------------------------------------------------------
// Scan driver — same idempotent pattern as the dako anniversary scan
// ---------------------------------------------------------------------------

export interface CelebrationScanSummary {
  scannedBirthdays: number;
  scannedAnniversaryTeachers: number;
  anniversaryGroups: number;
  createdNotifications: number;
}

/**
 * One idempotent pass over due birthday and oath-anniversary stages.
 * Repeat calls are no-ops thanks to the dedupe unique indexes.
 */
export async function runDueCelebrationScan(now: Date = new Date()): Promise<CelebrationScanSummary> {
  const rows = (await getDb().select().from(teachers)) as unknown as TeacherCelebrationRow[];
  let createdNotifications = 0;

  // #1 — individual birthday notices.
  const dueBirthdays = rows
    .filter((t) => t.birthday !== null && anniversaryStage(t.birthday as string, now) !== null)
    .map((t) => ({
      teacherId: t.id,
      stage: anniversaryStage(t.birthday as string, now) as AnniversaryStage,
      birthdayYear: nextAnniversary(t.birthday as string, now).anniversaryYear,
    }));
  for (const b of dueBirthdays) {
    const res = await recordTeacherBirthdayNotice(b.teacherId, b.birthdayYear, b.stage);
    createdNotifications += res.notifications;
  }

  // #2 — grouped oath-anniversary notices (ONE per date x stage).
  const dueAnniv = rows
    .filter((t) => t.dateOfOath !== null && anniversaryStage(t.dateOfOath, now) !== null)
    .map((t) => {
      const next = nextAnniversary(t.dateOfOath as string, now);
      return {
        teacherId: t.id,
        teacherName: tName(t),
        stage: anniversaryStage(t.dateOfOath as string, now) as AnniversaryStage,
        month: next.date.getUTCMonth() + 1,
        day: next.date.getUTCDate(),
        anniversaryYear: next.anniversaryYear,
        completedYears: next.anniversaryYear - Number((t.dateOfOath as string).slice(0, 4)),
      };
    });
  const grouped = new Map<string, (typeof dueAnniv)[number][]>();
  for (const a of dueAnniv) {
    const key = `${a.month}-${a.day}-${a.anniversaryYear}-${a.stage}`;
    const list = grouped.get(key) ?? [];
    list.push(a);
    grouped.set(key, list);
  }
  for (const list of grouped.values()) {
    const first = list[0];
    if (!first) continue;
    const res = await recordTeacherAnniversaryGroupNotice({
      month: first.month,
      day: first.day,
      anniversaryYear: first.anniversaryYear,
      notificationType: first.stage,
      teachersInGroup: list.map((t) => ({
        teacherId: t.teacherId,
        teacherName: t.teacherName,
        completedYears: t.completedYears,
      })),
    });
    createdNotifications += res.notifications;
  }

  return {
    scannedBirthdays: dueBirthdays.length,
    scannedAnniversaryTeachers: dueAnniv.length,
    anniversaryGroups: grouped.size,
    createdNotifications,
  };
}

/** Age helper re-export for surfaces that show a celebrant's age. */
export { calculateAge };

/** Teachers with no birthday/oath encoded (for the report's completeness note). */
export async function countTeachersMissingCelebrationDates(): Promise<{ missingBirthday: number; missingOath: number }> {
  const rows = (await getDb().select().from(teachers)) as unknown as TeacherCelebrationRow[];
  return {
    missingBirthday: rows.filter((t) => t.birthday === null).length,
    missingOath: rows.filter((t) => t.dateOfOath === null).length,
  };
}
