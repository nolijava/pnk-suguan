import { z } from "zod";
import {
  teacherStatusSchema,
  dakoStatusSchema,
  languageSchema,
  assignmentTypeSchema,
} from "./schemas";

const sortDir = z.enum(["asc", "desc"]);

export const teacherSortSchema = z.enum(["code", "name", "birthday", "status", "dateOfOath"]);
export const dakoSortSchema = z.enum(["code", "name", "worshipDay", "dateEstablished", "status"]);

/** §4/§8 Teacher list params. NOTE: no purokGrupo — final-confirmed exclusion. */
export const teacherQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    status: teacherStatusSchema.optional(),
    language: languageSchema.optional(),
    currentDestinationId: z.string().uuid().optional(),
    sort: teacherSortSchema.optional(),
    order: sortDir.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** §13 Dako list params — purokGrupo IS a dako filter. */
export const dakoQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    status: dakoStatusSchema.optional(),
    language: languageSchema.optional(),
    purokGrupo: z.string().max(100).optional(),
    worshipDay: z.enum(["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"]).optional(),
    sort: dakoSortSchema.optional(),
    order: sortDir.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** §9/§12 Set/change/clear destination; reason mandatory in all cases. */
export const currentDestinationChangeSchema = z
  .object({
    newDestinationId: z.string().uuid().nullable(),
    reason: z.string().min(1).max(500),
  })
  .strict();

/**
 * Phase 3 §10/§12 — weekly availability list params. The availability filter
 * includes NOT_ENCODED so unencoded teachers are explicitly identifiable.
 * NOTE: no purokGrupo — reference/display data only (never a teacher filter).
 */
export const availabilityFilterSchema = z.enum([
  "AVAILABLE",
  "ABSENT",
  "INACTIVE_WEEKLY",
  "INACTIVE_MASTER",
  "NOT_ENCODED",
]);

export const availabilityQuerySchema = z
  .object({
    weekId: z.string().uuid(),
    q: z.string().max(200).optional(),
    availability: availabilityFilterSchema.optional(),
    masterStatus: teacherStatusSchema.optional(),
    language: languageSchema.optional(),
    currentDestinationId: z.string().uuid().optional(),
    sort: z.enum(["code", "name"]).optional(),
    order: sortDir.optional(),
  })
  .strict();

/**
 * Phase 3 §8b — ADMIN availability correction on a PUBLISHED week.
 * `begin` requires a reason; `end` does not. The week status is never changed.
 */
export const availabilityCorrectionSchema = z
  .object({
    action: z.enum(["begin", "end"]),
    reason: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === "begin" && (!v.reason || !v.reason.trim())) {
      ctx.addIssue({ code: "custom", message: "reason is required to begin an availability correction" });
    }
  });

export type TeacherQuery = z.infer<typeof teacherQuerySchema>;
export type DakoQuery = z.infer<typeof dakoQuerySchema>;
export type CurrentDestinationChange = z.infer<typeof currentDestinationChangeSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type AvailabilityCorrection = z.infer<typeof availabilityCorrectionSchema>;

/**
 * Master plan E-1/E-2 — schedule correction (FINALIZED) and SUPER_ADMIN
 * PUBLISHED unlock. The secret never reaches logs, responses, or URLs; the
 * service produces an identical generic failure for wrong role / wrong
 * secret / bad state.
 */
export const scheduleCorrectionSchema = z
  .object({
    mode: z.enum(["FINALIZED", "PUBLISHED"]),
    action: z.enum(["begin", "end"]),
    reason: z.string().max(500).optional(),
    secret: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === "begin" && (!v.reason || !v.reason.trim())) {
      ctx.addIssue({ code: "custom", message: "reason is required to begin a schedule correction" });
    }
    if (v.mode === "PUBLISHED" && v.action === "begin" && (!v.secret || !v.secret)) {
      ctx.addIssue({ code: "custom", message: "secret is required for a PUBLISHED unlock" });
    }
  });

export type ScheduleCorrection = z.infer<typeof scheduleCorrectionSchema>;

/** Master plan E-4 — historical backfill batch input. */
export const historicalBatchSchema = z.object({
  weekId: z.string().uuid(),
  rows: z
    .array(
      z.object({
        dakoId: z.string().uuid(),
        teacherId: z.string().uuid(),
        assignmentType: z.enum(["SUGO", "RESERBA", "RESERBA_II"]),
      }),
    )
    .min(1)
    .max(500),
});

export type HistoricalBatch = z.infer<typeof historicalBatchSchema>;

/** Master plan E-4 — historical correction (reason mandatory). */
export const historicalCorrectionSchema = z.object({
  assignmentId: z.string().uuid(),
  teacherId: z.string().uuid().optional(),
  assignmentType: z.enum(["SUGO", "RESERBA", "RESERBA_II"]).optional(),
  reason: z.string().trim().min(1).max(500),
});

export type HistoricalCorrection = z.infer<typeof historicalCorrectionSchema>;

/** Master plan E-3 — destination assignment (close previous + create new). */
/** Master plan §19/§21/§22 — one week+dako+type slot's candidate list query. */
export const slotCandidatesQuerySchema = z.object({
  weekId: z.string().uuid(),
  dakoId: z.string().uuid(),
  assignmentType: assignmentTypeSchema,
  /** When replacing an existing assignment, it is excluded from the busy set. */
  assignmentId: z.string().uuid().optional(),
});

export const destinationAssignSchema = z.object({
  dakoId: z.string().uuid(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
    .optional(),
});

export type DestinationAssign = z.infer<typeof destinationAssignSchema>;

// ---------------------------------------------------------------------------
// L6 — query-parameter schemas
//
// Every URL parameter must be validated before it reaches a query, so a
// malformed value is a structured 400 (see `parseQuery`) rather than a driver
// error sanitized into a 500 — or a filter silently dropped. Values that are
// legitimately optional stay optional; a value that IS present must still be
// well-formed.
// ---------------------------------------------------------------------------

/** `weekId` as a REQUIRED parameter: /api/assignments, prev-week absences. */
export const weekIdQuerySchema = z.object({ weekId: z.string().uuid() }).strict();

/** /api/assignment-counts — all filters optional, but each must be well-formed. */
export const assignmentCountsQuerySchema = z
  .object({
    teacherId: z.string().uuid().optional(),
    dakoId: z.string().uuid().optional(),
    assignmentType: assignmentTypeSchema.optional(),
  })
  .strict();

/**
 * /api/audit-logs — `entityId` is a uuid column (a malformed one used to reach
 * the planner) and `pageSize` is bounded exactly as the service clamps it.
 */
export const auditLogsQuerySchema = z
  .object({
    entityType: z.string().min(1).max(100).optional(),
    entityId: z.string().uuid().optional(),
    action: z.string().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** /api/weeks — `year` is optional; a malformed one is rejected, never ignored. */
export const weeksQuerySchema = z
  .object({ year: z.coerce.number().int().min(1900).max(2999).optional() })
  .strict();

/** /api/schedule/annual — the ISO year whose schedule is requested. */
export const annualScheduleQuerySchema = z
  .object({ year: z.coerce.number().int().min(1900).max(2999) })
  .strict();

/**
 * /api/schedule/weekly-suguan-pdf — `year` + `week`. `week` is bounded to 53
 * here and checked against the ISO week count of `year` by the route, since
 * only that pairing can decide it.
 */
export const weeklySuguanPdfQuerySchema = z
  .object({
    year: z.coerce.number().int().min(1900).max(2999),
    week: z.coerce.number().int().min(1).max(53),
  })
  .strict();

/**
 * Mandated `reason` on the soft-disable/deactivate DELETE routes. Trimmed and
 * non-empty: a blank reason is the same caller error as a missing one, and the
 * service would otherwise reject it one layer later as a 422.
 */
export const reasonQuerySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export type WeekIdQuery = z.infer<typeof weekIdQuerySchema>;
export type AssignmentCountsQuery = z.infer<typeof assignmentCountsQuerySchema>;
export type AuditLogsQuery = z.infer<typeof auditLogsQuerySchema>;
export type WeeksQuery = z.infer<typeof weeksQuerySchema>;
export type AnnualScheduleQuery = z.infer<typeof annualScheduleQuerySchema>;
export type WeeklySuguanPdfQuery = z.infer<typeof weeklySuguanPdfQuerySchema>;
export type ReasonQuery = z.infer<typeof reasonQuerySchema>;
