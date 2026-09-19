export * from "./roles";
export * from "./users";
export * from "./sessions";
export * from "./password-reset";
export * from "./teachers";
export * from "./dako";
export * from "./weeks";
export * from "./teacher-availability";
export * from "./assignments";
export * from "./assignment-history";
export * from "./destination-history";
export * from "./notifications";
export * from "./audit-logs";

// Enums (text + CHECK in SQL for DDL simplicity, mirrored here for app typing)
export const USER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const TEACHER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const DAKO_STATUSES = ["ACTIVE", "DISABLED"] as const;
export const WEEK_STATUSES = ["DRAFT", "FINALIZED", "PUBLISHED"] as const;
export const AVAILABILITY_STATUSES = ["AVAILABLE", "ABSENT", "INACTIVE"] as const;
export const ASSIGNMENT_TYPES = ["SUGO", "RESERBA", "RESERBA_II"] as const;
export const ASSIGNMENT_TYPE_PRIORITY: Record<string, number> = {
  SUGO: 1,
  RESERBA: 2,
  RESERBA_II: 3,
};
export const ASSIGNMENT_SOURCES = ["AUTO", "MANUAL", "OVERRIDE", "HISTORICAL"] as const;
// Historical is an assignment SOURCE / backfill workflow classification (§33) —
// never a schedule status. Schedule status remains DRAFT/FINALIZED/PUBLISHED.
export const ASSIGNMENT_STATUSES = ["ASSIGNED", "ABSENT", "INACTIVE"] as const;
export const LANGUAGES = ["FILIPINO", "ENGLISH"] as const;
