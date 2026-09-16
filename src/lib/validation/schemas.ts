import { z } from "zod";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const timeHHMM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "expected HH:MM");

export const languageSchema = z.enum(["FILIPINO", "ENGLISH"]);
export const teacherStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export const dakoStatusSchema = z.enum(["ACTIVE", "DISABLED"]);
export const weekStatusSchema = z.enum(["DRAFT", "FINALIZED", "PUBLISHED"]);
export const availabilityStatusSchema = z.enum(["AVAILABLE", "ABSENT", "INACTIVE"]);
export const assignmentTypeSchema = z.enum(["SUGO", "RESERBA", "RESERBA_II"]);
export const assignmentSourceSchema = z.enum(["AUTO", "MANUAL", "OVERRIDE"]);
export const userStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

const teacherBaseSchema = z
  .object({
    teacherCode: z.string().min(1).max(32),
    firstName: z.string().min(1).max(100),
    middleName: z.string().max(100).optional(),
    lastName: z.string().min(1).max(100),
    suffix: z.string().max(10).optional(),
    birthday: dateStr.optional(),
    purokGrupo: z.string().max(100).optional(),
    dateOfOath: dateStr.optional(),
    currentDestinationId: z.string().uuid().optional(),
    language: languageSchema,
    remarks: z.string().max(2000).optional(),
  })
  .strict();

/** Cross-field checks applied to create/update payloads alike. */
function refineTeacher(v: {
  birthday?: string;
  dateOfOath?: string;
}, ctx: z.RefinementCtx): void {
  if (v.birthday) {
    const b = new Date(`${v.birthday}T00:00:00Z`);
    if (Number.isNaN(b.getTime()) || b > new Date()) {
      ctx.addIssue({ code: "custom", message: "birthday must be a valid past date" });
    }
  }
  if (v.dateOfOath) {
    const o = new Date(`${v.dateOfOath}T00:00:00Z`);
    if (Number.isNaN(o.getTime())) {
      ctx.addIssue({ code: "custom", message: "dateOfOath must be a valid date" });
    }
  }
}

export const teacherCreateSchema = teacherBaseSchema.superRefine(refineTeacher);
export const teacherUpdateSchema = teacherBaseSchema.partial().superRefine(refineTeacher);

export const teacherDeactivateSchema = z.object({
  inactiveReason: z.string().min(1).max(500),
}).strict();

export const dakoCreateSchema = z
  .object({
    dakoCode: z.string().min(1).max(32),
    name: z.string().min(1).max(200),
    address: z.string().min(1).max(500),
    dateEstablished: dateStr,
    purokGrupo: z.string().max(100).optional(),
    worshipDay: z.enum(["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"]),
    worshipTime: timeHHMM,
    language: languageSchema,
    remarks: z.string().max(2000).optional(),
  })
  .strict();

export const dakoUpdateSchema = dakoCreateSchema.partial();

export const dakoDisableSchema = z.object({
  disableReason: z.string().min(1).max(500),
}).strict();

export const weekCreateSchema = z
  .object({
    year: z.number().int().min(1900).max(2999),
    isoWeekNumber: z.number().int().min(1).max(53),
  })
  .strict();

export const weekStatusUpdateSchema = z.object({
  status: weekStatusSchema,
  reason: z.string().max(500).optional(),
}).strict();

export const availabilityUpsertSchema = z
  .object({
    teacherId: z.string().uuid(),
    weekId: z.string().uuid(),
    availabilityStatus: availabilityStatusSchema,
    reason: z.string().max(500).optional(),
    remarks: z.string().max(2000).optional(),
  })
  .strict();

/** Phase 3 §11 — batched weekly save: one transaction, per-row validation/audit. */
export const availabilityBulkSchema = z
  .object({
    changes: z.array(availabilityUpsertSchema).min(1).max(500),
  })
  .strict();

/** Phase 3 §11 refinement 3 — Fill Blanks as AVAILABLE target week. */
export const availabilityFillBlanksSchema = z
  .object({
    weekId: z.string().uuid(),
  })
  .strict();

export const assignmentCreateSchema = z
  .object({
    weekId: z.string().uuid(),
    dakoId: z.string().uuid(),
    teacherId: z.string().uuid(),
    assignmentType: assignmentTypeSchema,
    overrideReason: z.string().max(500).optional(),
  })
  .strict();

export const assignmentChangeSchema = z
  .object({
    teacherId: z.string().uuid().optional(),
    assignmentType: assignmentTypeSchema.optional(),
    reason: z.string().min(1, "reason is required for any assignment change").max(500),
  })
  .strict();

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
}).strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
}).strict();

export const userCreateSchema = z.object({
  email: z.string().email().max(200),
  fullName: z.string().min(1).max(200),
  password: z.string().min(10).max(200),
  roleCode: z.enum(["ADMIN", "SCHEDULER", "VIEWER"]),
}).strict();

export const notificationReadSchema = z.object({
  notificationIds: z.array(z.string().uuid()).min(1),
}).strict();

export type TeacherCreateInput = z.infer<typeof teacherCreateSchema>;
export type DakoCreateInput = z.infer<typeof dakoCreateSchema>;
export type AvailabilityUpsertInput = z.infer<typeof availabilityUpsertSchema>;
export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>;

// ---------------------------------------------------------------------------
// Phase 4 — scheduling engine
// ---------------------------------------------------------------------------

export const scheduleGenerateSchema = z
  .object({
    weekId: z.string().uuid(),
  })
  .strict();

export const eligibilityCheckSchema = z
  .object({
    weekId: z.string().uuid(),
    dakoId: z.string().uuid(),
    teacherId: z.string().uuid(),
  })
  .strict();

export type ScheduleGenerateInput = z.infer<typeof scheduleGenerateSchema>;
export type EligibilityCheckPayload = z.infer<typeof eligibilityCheckSchema>;
