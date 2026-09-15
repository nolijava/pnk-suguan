export type Permission =
  // users
  | "users.manage"
  // teachers
  | "teachers.read" | "teachers.write"
  // dako
  | "dako.read" | "dako.write"
  // weeks / schedule lifecycle
  | "weeks.read" | "weeks.write" | "weeks.finalize" | "weeks.publish" | "weeks.unlock"
  // availability
  | "availability.read" | "availability.write"
  // assignments
  | "assignments.read" | "assignments.write" | "assignments.override"
  | "assignments.history.read" | "assignments.counts.read"
  // scheduling (future phase)
  | "scheduling.generate"
  // notifications
  | "notifications.read" | "notifications.write"
  // audit + reports
  | "audit.read" | "reports.read";

const ADMIN: Permission[] = [
  "users.manage",
  "teachers.read", "teachers.write",
  "dako.read", "dako.write",
  "weeks.read", "weeks.write", "weeks.finalize", "weeks.publish", "weeks.unlock",
  "availability.read", "availability.write",
  "assignments.read", "assignments.write", "assignments.override",
  "assignments.history.read", "assignments.counts.read",
  "scheduling.generate",
  "notifications.read", "notifications.write",
  "audit.read", "reports.read",
];

const SCHEDULER: Permission[] = [
  "teachers.read", "teachers.write",
  "dako.read", "dako.write",
  "weeks.read", "weeks.write",
  "availability.read", "availability.write",
  "assignments.read", "assignments.write",
  "assignments.history.read", "assignments.counts.read",
  "scheduling.generate",
  "notifications.read",
  "reports.read",
];

const VIEWER: Permission[] = [
  "teachers.read", "dako.read", "weeks.read",
  "availability.read", "assignments.read",
  "assignments.history.read", "assignments.counts.read",
  "notifications.read", "reports.read",
];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  ADMIN,
  SCHEDULER,
  VIEWER,
};

export function permissionsForRoles(roleCodes: readonly string[]): Permission[] {
  const set = new Set<Permission>();
  for (const code of roleCodes) {
    for (const p of ROLE_PERMISSIONS[code] ?? []) set.add(p);
  }
  return [...set];
}

export function hasPermission(roleCodes: readonly string[], needed: Permission): boolean {
  return permissionsForRoles(roleCodes).includes(needed);
}
