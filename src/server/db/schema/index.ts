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
export * from "./magtuturo";
export * from "./notifications";
export * from "./teacher-celebrations";
export * from "./audit-logs";

export const USER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const TEACHER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const DAKO_STATUSES = ["ACTIVE", "DISABLED"] as const;
export const WEEK_STATUSES = ["DRAFT", "FINALIZED", "PUBLISHED"] as const;
export const AVAILABILITY_STATUSES = ["AVAILABLE", "ABSENT", "INACTIVE"] as const;
export const ASSIGNMENT_TYPES = ["SUGO", "RESERBA", "RESERBA_II"] as const;
export const MAGTUTURO_TYPES = ["SUGO", "RESERBA"] as const;
export const MAGTUTURO_SEATS: Record<string, number> = { SUGO: 4, RESERBA: 2 };
export const ASSIGNMENT_TYPE_PRIORITY: Record<string, number> = {
  SUGO: 0,
  RESERBA: 1,
  RESERBA_II: 2,
};
export const ASSIGNMENT_SOURCES = ["AUTO", "MANUAL", "OVERRIDE", "HISTORICAL"] as const;
export const MAGTUTURO_SOURCES = ["AUTO", "MANUAL", "OVERRIDE"] as const;
export const ASSIGNMENT_STATUSES = ["ASSIGNED", "ABSENT", "INACTIVE"] as const;
export const LANGUAGES = ["FILIPINO", "ENGLISH"] as const;
