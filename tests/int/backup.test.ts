import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, sql, resetTestDb, seedAdmin, teardown } from "./helpers";
import * as schema from "@/server/db/schema";
import { hasPermission } from "@/server/auth/permissions";

// Update #18 — Backup & Restore. Point the backups folder at a throwaway
// directory BEFORE the service reads it, so no test ever writes to the real
// %LOCALAPPDATA%\PNK Suguan\backups.
const backupRoot = mkdtempSync(path.join(os.tmpdir(), "pnk-backups-test-"));
process.env.PNK_BACKUP_DIR = backupRoot;

const backupService = await import("@/server/services/backup.service");

describe("Update #18 — backup / restore", () => {
  let adminId: string;

  beforeAll(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
  });

  afterAll(async () => {
    await teardown();
    rmSync(backupRoot, { recursive: true, force: true });
  });

  it("createBackup writes a pg_dump archive and audits CREATED_BACKUP", async () => {
    const entry = await backupService.createBackup({ userId: adminId });
    expect(entry.name).toMatch(/^pnk-backup-.*\.dump$/);
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(path.join(backupRoot, entry.name))).toBe(true);
    // pg_dump custom-format archives start with the PGDMP magic.
    const magic = readFileSync(path.join(backupRoot, entry.name)).subarray(0, 5).toString("latin1");
    expect(magic).toBe("PGDMP");
    expect((await backupService.listBackups()).some((b) => b.name === entry.name)).toBe(true);

    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "CREATED_BACKUP"));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("restore refuses backup names that are not plain *.dump file names", async () => {
    await expect(
      backupService.restoreBackup({ userId: adminId }, { filename: "../evil.dump", confirm: "../evil.dump" }),
    ).rejects.toThrow(/invalid backup file name/i);
    await expect(
      backupService.restoreBackup({ userId: adminId }, { filename: "sub/dir.dump", confirm: "sub/dir.dump" }),
    ).rejects.toThrow(/invalid backup file name/i);
  });

  it("restore requires the typed file name as confirmation (strong confirm)", async () => {
    const entry = await backupService.createBackup({ userId: adminId });
    await expect(
      backupService.restoreBackup({ userId: adminId }, { filename: entry.name, confirm: "wrong" }),
    ).rejects.toThrow(/confirmation/i);
    // Nothing was restored → no RESTORED_BACKUP audit row yet.
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "RESTORED_BACKUP"));
    expect(logs.length).toBe(0);
  });

  it("restore validates archive integrity BEFORE touching the database", async () => {
    // A syntactically safe name with garbage content: pg_restore --list must
    // reject it and the restore must abort with the DB untouched.
    const corruptName = "corrupt-test.dump";
    writeFileSync(path.join(backupRoot, corruptName), "this is not a pg_dump archive");
    await expect(
      backupService.restoreBackup({ userId: adminId }, { filename: corruptName, confirm: corruptName }),
    ).rejects.toThrow(/pg_restore/i);
    // Still no restore recorded, and the seeded admin is still present.
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "RESTORED_BACKUP"));
    expect(logs.length).toBe(0);
    const admins = await db.select().from(schema.users).where(eq(schema.users.id, adminId));
    expect(admins.length).toBe(1);
    rmSync(path.join(backupRoot, corruptName), { force: true });
  });

  it("restore round-trips data, takes a pre-restore safety backup, and is audited", async () => {
    // Baseline row → backup → destroy → restore → row must come back.
    const [t] = await db
      .insert(schema.teachers)
      .values({
        teacherCode: "T-BK01",
        firstName: "Backup",
        lastName: "Roundtrip",
        language: "FILIPINO",
        status: "ACTIVE",
      })
      .returning();
    const entry = await backupService.createBackup({ userId: adminId });

    await sql`DELETE FROM teachers WHERE id = ${t!.id}`;
    expect((await db.select().from(schema.teachers).where(eq(schema.teachers.id, t!.id))).length).toBe(0);

    const result = await backupService.restoreBackup({
      userId: adminId,
    }, { filename: entry.name, confirm: entry.name });
    expect(result.restored).toBe(entry.name);
    expect(result.restartRequired).toBe(true);
    // Safety backup was taken first and is on disk.
    expect(result.safetyBackup).toMatch(/^pre-restore-.*\.dump$/);
    expect(existsSync(path.join(backupRoot, result.safetyBackup))).toBe(true);

    // The row is back — the restore actually ran.
    const restored = await db.select().from(schema.teachers).where(eq(schema.teachers.id, t!.id));
    expect(restored.length).toBe(1);
    expect(restored[0]!.teacherCode).toBe("T-BK01");

    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "RESTORED_BACKUP"));
    expect(logs.length).toBe(1);
  });

  it("RBAC — VIEWER can never restore (or write) backups", () => {
    expect(hasPermission(["VIEWER"], "backups.read")).toBe(true);
    expect(hasPermission(["VIEWER"], "backups.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "backups.restore")).toBe(false);
    expect(hasPermission(["ADMIN"], "backups.restore")).toBe(true);
    expect(hasPermission(["SUPER_ADMIN"], "backups.restore")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "backups.restore")).toBe(false);
  });

  // ------------------------------------------------------------------
  // Update #18+ — Backup location options + Restore from other location.
  // The dialog layer is stubbed (PNK_DIALOG_STUB) — everything below the
  // OS dialog (tokens, custom destinations, untrusted-file handling, the
  // guarded external restore) runs exactly as in production.
  // ------------------------------------------------------------------
  describe("location options + restore from other location", () => {
    const customDir = mkdtempSync(path.join(os.tmpdir(), "pnk-backups-custom-"));
    const withStub = async <T>(picked: string, fn: () => Promise<T>): Promise<T> => {
      process.env.PNK_DIALOG_STUB = picked;
      try {
        return await fn();
      } finally {
        delete process.env.PNK_DIALOG_STUB;
      }
    };

    afterAll(() => {
      rmSync(customDir, { recursive: true, force: true });
    });

    it("Create Backup → Choose Different Location writes the same pg_dump archive there", async () => {
      const chosen = path.join(customDir, "September backup.dump"); // realistic Save-dialog name
      const picked = await withStub(chosen, () => backupService.pickBackupDestination({ userId: adminId }));
      expect(picked.cancelled).toBe(false);

      const entry = await backupService.createBackup({ userId: adminId }, "pnk-backup", { pickToken: picked.token! });
      expect(entry.name).toBe("September backup.dump");
      expect(path.basename(entry.destination!)).toBe(path.basename(customDir));
      expect(existsSync(chosen)).toBe(true);
      // Real PostgreSQL-native archive + integrity validation ran.
      expect(readFileSync(chosen).subarray(0, 5).toString("latin1")).toBe("PGDMP");
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect((await backupService.inspectBackupFile(chosen)).valid).toBe(true);

      // Same metadata + audit as a default-location backup.
      const logs = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "CREATED_BACKUP"));
      const mine = logs.find((l) => (l.newValue as { name?: string } | null)?.name === "September backup.dump");
      expect(mine).toBeTruthy();
      expect((mine!.newValue as { destination: string }).destination).toContain(path.basename(customDir));
      expect((mine!.newValue as { validation: string }).validation).toContain("OK");

      // The default-folder catalog is unchanged — no silent copy/move.
      expect((await backupService.listBackups()).some((b) => b.name === "September backup.dump")).toBe(false);
    });

    it("a cancelled picker creates nothing", async () => {
      const picked = await withStub("", () => backupService.pickBackupDestination({ userId: adminId }));
      expect(picked).toEqual({ cancelled: true });
    });

    it("failed destination → clear error + BACKUP_FAILED audit, never a success record", async () => {
      const missing = path.join(customDir, "missing-sub", "x.dump");
      await expect(
        backupService.createBackup({ userId: adminId }, "pnk-backup", { filePath: missing }),
      ).rejects.toThrow(/not an accessible folder/i);
      expect(existsSync(path.join(customDir, "missing-sub"))).toBe(false);

      const failed = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "BACKUP_FAILED"));
      expect(failed.length).toBeGreaterThanOrEqual(1);
      const created = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "CREATED_BACKUP"));
      expect(created.some((l) => (l.newValue as { name?: string } | null)?.name === "x.dump")).toBe(false);
    });

    it("custom paths must be plain absolute *.dump files", async () => {
      await expect(
        backupService.createBackup({ userId: adminId }, "pnk-backup", { filePath: path.join(customDir, "evil.sql") }),
      ).rejects.toThrow(/must be a \*\.dump/i);
      await expect(
        backupService.createBackup({ userId: adminId }, "pnk-backup", { filePath: path.join(customDir, "bad*name.dump") }),
      ).rejects.toThrow(/plain file name/i);
    });

    it("inspection reports hash + TOC entries for a valid backup", async () => {
      const entry = await backupService.createBackup({ userId: adminId });
      const info = await backupService.inspectBackupFile(path.join(backupRoot, entry.name));
      expect(info.valid).toBe(true);
      expect(info.entries).toBeGreaterThan(0);
      expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a .dump extension grants no trust — garbage/truncated files are rejected", async () => {
      const garbage = path.join(customDir, "garbage.dump");
      writeFileSync(garbage, "this is not a pg_dump archive");
      const g = await backupService.inspectBackupFile(garbage);
      expect(g.valid).toBe(false);
      expect(g.error).toMatch(/PGDMP header/i);

      const truncated = path.join(customDir, "truncated.dump");
      writeFileSync(truncated, "PGDMP\u0000\u0001 garbage after the magic");
      const t = await backupService.inspectBackupFile(truncated);
      expect(t.valid).toBe(false);
      expect(t.error).toMatch(/pg_restore/i);

      const missing = await backupService.inspectBackupFile(path.join(customDir, "nope.dump"));
      expect(missing.valid).toBe(false);
      expect(missing.error).toMatch(/not found/i);

      await expect(backupService.inspectBackupFile(path.join(customDir, "notes.txt"))).rejects.toThrow(/must be a \*\.dump/i);
    });

    it("Restore from other location: pick → inspect → strong confirm → safety backup → restore → audit", async () => {
      const [t] = await db
        .insert(schema.teachers)
        .values({
          teacherCode: "T-EXT1",
          firstName: "External",
          lastName: "Roundtrip",
          language: "FILIPINO",
          status: "ACTIVE",
        })
        .returning();
      const extPath = path.join(customDir, "external-restore.dump");
      await backupService.createBackup({ userId: adminId }, "pnk-backup", { filePath: extPath });
      await sql`DELETE FROM teachers WHERE id = ${t!.id}`;
      expect((await db.select().from(schema.teachers).where(eq(schema.teachers.id, t!.id))).length).toBe(0);

      // Pick the file through the (stubbed) native dialog — inspected on pick.
      const picked = await withStub(extPath, () => backupService.pickRestoreFile({ userId: adminId }));
      expect(picked.cancelled).toBe(false);
      expect(picked.inspect!.valid).toBe(true);

      // Strong confirm: the typed name must match the file name exactly.
      await expect(
        backupService.restoreFromFile({ userId: adminId }, { pickToken: picked.token!, confirm: "wrong.dump" }),
      ).rejects.toThrow(/confirmation/i);
      expect((await db.select().from(schema.teachers).where(eq(schema.teachers.id, t!.id))).length).toBe(0);

      const res = await backupService.restoreFromFile(
        { userId: adminId },
        { pickToken: picked.token!, confirm: "external-restore.dump" },
      );
      expect(res.source).toBe("external");
      expect(res.restored).toBe("external-restore.dump");
      expect(res.targetDatabase).toBeTruthy();
      // The pre-restore safety backup lands in the DEFAULT backups folder.
      expect(res.safetyBackup).toMatch(/^pre-restore-.*\.dump$/);
      expect(existsSync(path.join(backupRoot, res.safetyBackup))).toBe(true);
      // The row is back — the external restore actually ran.
      const back = await db.select().from(schema.teachers).where(eq(schema.teachers.id, t!.id));
      expect(back.length).toBe(1);
      expect(back[0]!.teacherCode).toBe("T-EXT1");

      const logs = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "RESTORED_BACKUP"));
      const mine = logs.find((l) => (l.newValue as { source?: string } | null)?.source === "external");
      expect(mine).toBeTruthy();
      expect((mine!.newValue as { safetyBackup: string }).safetyBackup).toBe(res.safetyBackup);
      expect((mine!.newValue as { targetDatabase: string }).targetDatabase).toBeTruthy();
    });

    it("corrupt external backup is rejected before any write and audited as RESTORE_FAILED", async () => {
      const corrupt = path.join(customDir, "corrupt-external.dump");
      writeFileSync(corrupt, "garbage with a .dump name");
      await expect(
        backupService.restoreFromFile({ userId: adminId }, { filePath: corrupt, confirm: "corrupt-external.dump" }),
      ).rejects.toThrow(/pg_restore/i);
      const failed = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "RESTORE_FAILED"));
      const mine = failed.find((l) => (l.newValue as { source?: string } | null)?.source === "external");
      expect(mine).toBeTruthy();
      expect((mine!.newValue as { error: string }).error).toMatch(/pg_restore/i);
    });

    it("target-database guard refuses a non-local restore target", async () => {
      const extPath = path.join(customDir, "external-restore.dump");
      const original = process.env.DATABASE_URL;
      process.env.DATABASE_URL = "postgresql://pnk:pnk@db.example.com:5432/pnk";
      try {
        await expect(
          backupService.restoreFromFile({ userId: adminId }, { filePath: extPath, confirm: "external-restore.dump" }),
        ).rejects.toThrow(/restore refused|not this machine/i);
      } finally {
        process.env.DATABASE_URL = original;
      }
    });

    it("pick tokens are unforgeable, one-shot and owner-bound", async () => {
      await expect(
        backupService.createBackup({ userId: adminId }, "pnk-backup", { pickToken: "forged-token" }),
      ).rejects.toThrow(/expired|not valid/i);
      await expect(
        backupService.restoreFromFile({ userId: adminId }, { pickToken: "forged-token", confirm: "x" }),
      ).rejects.toThrow(/expired|not valid/i);

      const chosen = path.join(customDir, "onetime.dump");
      const picked = await withStub(chosen, () => backupService.pickBackupDestination({ userId: adminId }));
      // Another user cannot spend someone else's token.
      await expect(
        backupService.createBackup({ userId: "someone-else" }, "pnk-backup", { pickToken: picked.token! }),
      ).rejects.toThrow(/expired|not valid/i);
      // Legit use works once…
      await backupService.createBackup({ userId: adminId }, "pnk-backup", { pickToken: picked.token! });
      expect(existsSync(chosen)).toBe(true);
      // …and never twice.
      await expect(
        backupService.createBackup({ userId: adminId }, "pnk-backup", { pickToken: picked.token! }),
      ).rejects.toThrow(/expired|not valid/i);
    });
  });
});
