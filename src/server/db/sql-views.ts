import { pgView, text, timestamp, integer, uuid, boolean } from "drizzle-orm/pg-core";

/**
 * Typed access to views created in migration 0001.
 * These are read-models; writes go through the base tables only.
 */
export const profiles = pgView("profiles", {
  id: uuid("id"),
  email: text("email"),
  fullName: text("full_name"),
  status: text("status"),
  mustChangePassword: boolean("mustChangePassword"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  roles: text("roles").array(),
}).existing();

export const vAssignmentCounts = pgView("v_assignment_counts", {
  teacherId: uuid("teacher_id"),
  dakoId: uuid("dako_id"),
  assignmentType: text("assignment_type"),
  total: integer("total"),
  yearTotal: integer("year_total"),
  lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
}).existing();
