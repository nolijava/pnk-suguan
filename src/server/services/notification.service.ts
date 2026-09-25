import { and, eq, isNull, desc, inArray } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { notifications, dakoAnniversaryNotifications, dako, users, userRoles, roles } from "@/server/db/schema";
import { NotFoundError } from "@/lib/errors";
import { anniversaryStage, nextAnniversary } from "@/lib/anniversary";

export async function listNotificationsForUser(userId: string, limit = 50) {
  return getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/** Mark the given notifications read; only rows owned by the user are affected. */
export async function markNotificationsRead(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function createNotification(values: {
  userId: string;
  notificationType: string;
  title: string;
  message?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  scheduledFor?: Date;
}) {
  const [row] = await getDb().insert(notifications).values(values).returning();
  return row;
}

/** Fan-out target for anniversary alerts: all active ADMIN users (§7/§27). */
export async function adminUserIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, "ADMIN"), eq(users.status, "ACTIVE")));
  return rows.map((r) => r.id);
}

/** Idempotent create honoring the dako+year+type dedupe (§28). */
export async function recordDakoAnniversaryNotification(
  dakoId: string,
  anniversaryYear: number,
  notificationType: string,
): Promise<{ created: boolean; notifications: number }> {
  const db = getDb();
  const existing = await db
    .select({ id: dakoAnniversaryNotifications.id })
    .from(dakoAnniversaryNotifications)
    .where(
      and(
        eq(dakoAnniversaryNotifications.dakoId, dakoId),
        eq(dakoAnniversaryNotifications.anniversaryYear, anniversaryYear),
        eq(dakoAnniversaryNotifications.notificationType, notificationType),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { created: false, notifications: 0 };

  const d = (await db.select().from(dako).where(eq(dako.id, dakoId)).limit(1))[0];
  if (!d) throw new NotFoundError("dako not found");

  const admins = await adminUserIds();
  if (admins.length === 0) return { created: false, notifications: 0 };

  const count = await db.transaction(async (tx) => {
    await tx
      .insert(dakoAnniversaryNotifications)
      .values({ dakoId, anniversaryYear, notificationType });
    await tx.insert(notifications).values(
      admins.map((userId) => ({
        userId,
        notificationType,
        title: anniversaryTitle(notificationType, d.name),
        message: anniversaryMessage(notificationType, d.name),
        relatedEntityType: "dako",
        relatedEntityId: dakoId,
      })),
    );
    return admins.length;
  });
  return { created: true, notifications: count };
}

function anniversaryTitle(type: string, name: string): string {
  switch (type) {
    case "ONE_MONTH_BEFORE": return `1 month to ${name} anniversary`;
    case "APPROACHING": return `${name} anniversary approaching`;
    case "ONE_DAY_BEFORE": return `Tomorrow: ${name} anniversary`;
    case "TODAY": return `Today: ${name} anniversary`;
    default: return `${name} anniversary`;
  }
}

function anniversaryMessage(type: string, name: string): string {
  switch (type) {
    case "ONE_MONTH_BEFORE": return `${name} reaches its next anniversary in one month.`;
    case "APPROACHING": return `${name} anniversary is coming up soon.`;
    case "ONE_DAY_BEFORE": return `${name} celebrates its anniversary tomorrow.`;
    case "TODAY": return `${name} celebrates its anniversary today!`;
    default: return `${name} anniversary notification.`;
  }
}

/** Scan helper the Phase 8 notifier calls every ~6h. */
export async function dueAnniversaryNotifications(now: Date = new Date()) {
  const rows = await getDb().select().from(dako).where(eq(dako.status, "ACTIVE"));
  return rows
    .map((d) => ({ dako: d, stage: anniversaryStage(d.dateEstablished, now) }))
    .filter((r) => r.stage !== null)
    .map((r) => ({
      dakoId: r.dako.id,
      dakoName: r.dako.name,
      stage: r.stage as NonNullable<typeof r.stage>,
      anniversaryYear: nextAnniversary(r.dako.dateEstablished, now).anniversaryYear,
    }));
}

/**
 * Phase 8 — one idempotent notifier pass: scan due anniversary stages and
 * run each through the existing dedupe/fan-out service. Safe to call any
 * number of times (unique index on dako+year+type makes repeats no-ops);
 * a restart/downtime self-heals on the next scan. Returns a small summary
 * for the instrumentation log and the ADMIN scan endpoint.
 */
export async function runDueAnniversaryScan(now: Date = new Date()): Promise<{
  scannedDakos: number;
  dueStages: number;
  createdNotifications: number;
  /** Update #1/#2 — Guro birthday + grouped oath-anniversary notices. */
  celebrations: Awaited<ReturnType<typeof import("./celebration.service").runDueCelebrationScan>>;
}> {
  const due = await dueAnniversaryNotifications(now);
  let createdNotifications = 0;
  for (const d of due) {
    const res = await recordDakoAnniversaryNotification(d.dakoId, d.anniversaryYear, d.stage);
    createdNotifications += res.notifications;
  }
  // Update #1/#2 — same idempotent pattern for teacher celebrations.
  const { runDueCelebrationScan } = await import("./celebration.service");
  const celebrations = await runDueCelebrationScan(now);
  return {
    scannedDakos: due.length,
    dueStages: due.length,
    createdNotifications: createdNotifications + celebrations.createdNotifications,
    celebrations,
  };
}
