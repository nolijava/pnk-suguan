import { z } from "zod";
import {
  teacherStatusSchema,
  dakoStatusSchema,
  languageSchema,
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

export type TeacherQuery = z.infer<typeof teacherQuerySchema>;
export type DakoQuery = z.infer<typeof dakoQuerySchema>;
export type CurrentDestinationChange = z.infer<typeof currentDestinationChangeSchema>;
