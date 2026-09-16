/**
 * Phase 4 — Suguan Scheduling Engine types.
 *
 * Hard eligibility (§4) is separated from fairness/scoring (§8) and from
 * deterministic tie-breaking (§12). Pure data — no DB types leak in here
 * so the core is unit-testable without a database.
 */

export type AssignmentType = "SUGO" | "RESERBA" | "RESERBA_II";

/** §11 reason taxonomy for unassigned slots. */
export type UnassignedReasonCode =
  | "NO_ELIGIBLE_CANDIDATES"
  | "ALL_ABSENT_LAST_WEEK"
  | "LANGUAGE_MISMATCH"
  | "INSUFFICIENT_FOR_RESERBA_II";

/** §4 hard-rule taxonomy — automatic scheduling never bypasses these. */
export type HardRuleCode =
  | "TEACHER_INACTIVE_MASTER"
  | "DAKO_DISABLED"
  | "WEEKLY_INACTIVE"
  | "WEEKLY_ABSENT"
  | "NOT_ENCODED"
  | "LANGUAGE_MISMATCH"
  | "PREVIOUS_WEEK_ABSENT"
  | "ALREADY_ASSIGNED_THIS_WEEK";

/** One teacher in the candidate pool (plain JSON-safe shape). */
export interface CandidateTeacher {
  teacherId: string;
  teacherCode: string;
  fullName: string;
  language: "FILIPINO" | "ENGLISH";
  /** Master status (ACTIVE/INACTIVE) — authoritative over weekly state (§14). */
  status: string;
  currentDestinationId: string | null;
}

/** One Dako to be scheduled. */
export interface ScheduleDako {
  dakoId: string;
  dakoCode: string;
  dakoName: string;
  language: "FILIPINO" | "ENGLISH";
  status: string;
}

/** Immutable per-week scheduling context built from ~6 set-based queries. */
export interface SchedulingContext {
  weekId: string;
  year: number;
  isoWeekNumber: number;
  weekStatus: string;
  teachers: CandidateTeacher[];
  dakos: ScheduleDako[];
  /** Weekly availability by teacherId (status + reason). */
  availability: Map<string, { status: string; reason: string | null }>;
  /** Teachers ABSENT in the immediately preceding week (hard exclusion §5). */
  prevWeekAbsent: Set<string>;
  /** Historical ASSIGNED counts per teacher×dako×type (primary fairness factor). */
  counts: Map<string, { total: number; yearTotal: number; lastAssignedAt: string | null }>;
  /** Assignments already in the week (e.g. MANUAL/OVERRIDE rows). */
  weekAssignments: Map<
    string,
    { teacherId: string; assignmentType: string; assignmentSource: string }
  >;
  /** Dako|type slots occupied by surviving MANUAL/OVERRIDE rows — the engine skips them (§13). */
  occupiedSlots: Set<string>;
  /** Dako each teacher was assigned to in the PREVIOUS week (consecutive/recency tie-breakers). */
  prevWeekAssignment: Map<string, string>; // teacherId -> dakoId
}

export interface CandidateEvaluation {
  candidate: CandidateTeacher;
  eligible: boolean;
  violatedRules: HardRuleCode[];
}

/** Result for one Dako × assignment-type slot. */
export interface SlotResult {
  dakoId: string;
  dakoCode: string;
  dakoName: string;
  assignmentType: AssignmentType;
  teacherId: string | null;
  teacherCode: string | null;
  fullName: string | null;
  score: number | null;
  reasonCode: UnassignedReasonCode | null;
  reason: string | null;
  /** How the pool was exhausted for this slot (§11 transparency). */
  candidateStats: {
    poolSize: number;
    excludedByRule: Record<string, number>;
  };
}

export interface AllocationPlan {
  slots: SlotResult[];
  summary: {
    dakos: number;
    sugoAssigned: number;
    reserbaAssigned: number;
    reserbaIiAssigned: number;
    unassigned: number;
  };
}

export interface SlotAssignmentInput {
  dakoId: string;
  teacherId: string;
  assignmentType: AssignmentType;
}

/** Violated hard rules for a proposed (teacher, dako, week) triple. */
export interface EligibilityCheckResult {
  eligible: boolean;
  violatedRules: HardRuleCode[];
  /** Which rules ADMIN override may bypass (all of the above except DAKO_DISABLED). */
  overrideAllowed: boolean;
}
