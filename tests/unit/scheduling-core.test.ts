/**
 * Phase 4 — pure-core unit tests: hard-rule eligibility matrix (§4/§5),
 * fairness scoring chain (§8), deterministic tie-breaking (§12), and the
 * leftover-pool allocation rule (§9/§4). No DB — plain context objects.
 */
import { describe, it, expect } from "vitest";
import { evaluateCandidate } from "@/server/services/scheduling/eligibility";
import { allocate, rankedEligible, candidateKey } from "@/server/services/scheduling/scoring";
import type { CandidateTeacher, SchedulingContext, ScheduleDako } from "@/server/services/scheduling/types";

function teacher(over: Partial<CandidateTeacher> = {}): CandidateTeacher {
  return {
    teacherId: "t1",
    teacherCode: "TC-001",
    fullName: "One Teacher",
    language: "FILIPINO",
    status: "ACTIVE",
    currentDestinationId: null,
    ...over,
  };
}

function dako(over: Partial<ScheduleDako> = {}): ScheduleDako {
  return {
    dakoId: "d1",
    dakoCode: "DK-001",
    dakoName: "Dako One",
    language: "FILIPINO",
    status: "ACTIVE",
    ...over,
  };
}

function ctx(over: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    weekId: "w1",
    year: 2026,
    isoWeekNumber: 40,
    weekStatus: "DRAFT",
    teachers: [teacher()],
    dakos: [dako()],
    availability: new Map([["t1", { status: "AVAILABLE", reason: null }]]),
    prevWeekAbsent: new Set(),
    counts: new Map(),
    weekAssignments: new Map(),
    occupiedSlots: new Set(),
    prevWeekAssignment: new Map(),
    ...over,
  };
}

describe("evaluateCandidate — hard-rule matrix (§4)", () => {
  it("accepts a fully eligible candidate", () => {
    const r = evaluateCandidate(teacher(), dako(), ctx());
    expect(r.eligible).toBe(true);
    expect(r.violatedRules).toEqual([]);
  });

  it("violates TEACHER_INACTIVE_MASTER when master status is INACTIVE", () => {
    const r = evaluateCandidate(teacher({ status: "INACTIVE" }), dako(), ctx());
    expect(r.violatedRules).toContain("TEACHER_INACTIVE_MASTER");
  });

  it("violates DAKO_DISABLED when the dako is disabled", () => {
    const r = evaluateCandidate(teacher(), dako({ status: "DISABLED" }), ctx());
    expect(r.violatedRules).toContain("DAKO_DISABLED");
  });

  it("violates WEEKLY_ABSENT and WEEKLY_INACTIVE for those weekly states", () => {
    const absent = evaluateCandidate(teacher(), dako(), ctx({
      availability: new Map([["t1", { status: "ABSENT", reason: "travel" }]]),
    }));
    expect(absent.violatedRules).toContain("WEEKLY_ABSENT");
    const inactive = evaluateCandidate(teacher(), dako(), ctx({
      availability: new Map([["t1", { status: "INACTIVE", reason: null }]]),
    }));
    expect(inactive.violatedRules).toContain("WEEKLY_INACTIVE");
  });

  it("violates NOT_ENCODED when no availability record exists (§7)", () => {
    const r = evaluateCandidate(teacher(), dako(), ctx({ availability: new Map() }));
    expect(r.violatedRules).toContain("NOT_ENCODED");
  });

  it("violates PREVIOUS_WEEK_ABSENT (hard exclusion §5)", () => {
    const r = evaluateCandidate(teacher(), dako(), ctx({ prevWeekAbsent: new Set(["t1"]) }));
    expect(r.violatedRules).toContain("PREVIOUS_WEEK_ABSENT");
  });

  it("violates LANGUAGE_MISMATCH only for Filipino teacher → English dako (§5.E)", () => {
    const filToEng = evaluateCandidate(teacher(), dako({ language: "ENGLISH" }), ctx());
    expect(filToEng.violatedRules).toContain("LANGUAGE_MISMATCH");
    const engToEng = evaluateCandidate(teacher({ language: "ENGLISH" }), dako({ language: "ENGLISH" }), ctx());
    expect(engToEng.eligible).toBe(true);
    const engToFil = evaluateCandidate(teacher({ language: "ENGLISH" }), dako(), ctx());
    expect(engToFil.eligible).toBe(true);
  });

  it("violates ALREADY_ASSIGNED_THIS_WEEK when the teacher holds a slot", () => {
    const r = evaluateCandidate(teacher(), dako(), ctx({
      weekAssignments: new Map([["t1", { teacherId: "t1", assignmentType: "SUGO", assignmentSource: "MANUAL" }]]),
    }));
    expect(r.violatedRules).toContain("ALREADY_ASSIGNED_THIS_WEEK");
  });

  it("master-INACTIVE with weekly AVAILABLE still violates (weekly never overrides master, §14)", () => {
    const r = evaluateCandidate(
      teacher({ status: "INACTIVE" }),
      dako(),
      ctx({ availability: new Map([["t1", { status: "AVAILABLE", reason: null }]]) }),
    );
    expect(r.violatedRules).toContain("TEACHER_INACTIVE_MASTER");
  });
});

function bigCtx(teachers: CandidateTeacher[], dakos: ScheduleDako[], counts: [string, { total: number; yearTotal: number; lastAssignedAt: string | null }][]): SchedulingContext {
  return {
    weekId: "w1",
    year: 2026,
    isoWeekNumber: 40,
    weekStatus: "DRAFT",
    teachers,
    dakos,
    availability: new Map(teachers.map((t) => [t.teacherId, { status: "AVAILABLE", reason: null }])),
    prevWeekAbsent: new Set(),
    counts: new Map(counts),
    weekAssignments: new Map(),
    occupiedSlots: new Set(),
    prevWeekAssignment: new Map(),
  };
}

describe("scoring chain (§8) and determinism (§12)", () => {
  it("primary factor: lowest teacher×dako×type count wins", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const b = teacher({ teacherId: "b", teacherCode: "TC-B" });
    const d = dako();
    const c = bigCtx([a, b], [d], [
      ["a|d1|SUGO", { total: 2, yearTotal: 2, lastAssignedAt: null }],
      ["b|d1|SUGO", { total: 5, yearTotal: 5, lastAssignedAt: null }],
    ]);
    const { ranked } = rankedEligible([a, b], d, "SUGO", c);
    expect(ranked[0]!.teacherId).toBe("a");
  });

  it("ties on primary fall through to total count, then teacherCode (deterministic)", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-B" }); // same totals; code decides
    const b = teacher({ teacherId: "b", teacherCode: "TC-A" });
    const d = dako();
    const c = bigCtx([a, b], [d], []);
    const { ranked } = rankedEligible([a, b], d, "SUGO", c);
    expect(ranked.map((t) => t.teacherCode)).toEqual(["TC-A", "TC-B"]);
  });

  it("current-destination teacher is preferred on equal counts (§8 item 6)", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A", currentDestinationId: "d1" });
    const b = teacher({ teacherId: "b", teacherCode: "TC-B" });
    const d = dako();
    const c = bigCtx([a, b], [d], []);
    const ka = candidateKey(a, d, "SUGO", c);
    const kb = candidateKey(b, d, "SUGO", c);
    expect(ka![6]!).toBeLessThan(kb![6]!); // destination preference component
  });

  it("consecutive-same-dako (assigned last week to same dako) penalizes", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const b = teacher({ teacherId: "b", teacherCode: "TC-B" });
    const d = dako();
    const c = bigCtx([a, b], [d], []);
    c.prevWeekAssignment.set("a", "d1");
    const ka = candidateKey(a, d, "SUGO", c);
    const kb = candidateKey(b, d, "SUGO", c);
    expect(ka![4]!).toBe(1);
    expect(kb![4]!).toBe(0);
  });
});

describe("allocation — leftover-pool RESERBA_II (§9/§4 approved rule)", () => {
  it("fills SUGO and RESERBA first; RESERBA_II only from leftovers", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const b = teacher({ teacherId: "b", teacherCode: "TC-B" });
    const d = dako();
    const plan = allocate(bigCtx([a, b], [d], []));
    const sugo = plan.slots.find((s) => s.assignmentType === "SUGO")!;
    const reserba = plan.slots.find((s) => s.assignmentType === "RESERBA")!;
    const reserba2 = plan.slots.find((s) => s.assignmentType === "RESERBA_II")!;
    expect(sugo.teacherId).toBe("a");
    expect(reserba.teacherId).toBe("b");
    expect(reserba2.teacherId).toBeNull();
    expect(reserba2.reasonCode).toBe("INSUFFICIENT_FOR_RESERBA_II");
  });

  it("three teachers fill all three slots of one dako", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const b = teacher({ teacherId: "b", teacherCode: "TC-B" });
    const c = teacher({ teacherId: "c", teacherCode: "TC-C" });
    const d = dako();
    const plan = allocate(bigCtx([a, b, c], [d], []));
    expect(plan.summary.sugoAssigned).toBe(1);
    expect(plan.summary.reserbaAssigned).toBe(1);
    expect(plan.summary.reserbaIiAssigned).toBe(1);
    expect(plan.summary.unassigned).toBe(0);
  });

  it("two dakos consume teachers before any RESERBA_II (no stealing, §4)", () => {
    const t = ["a", "b", "c"].map((id) => teacher({ teacherId: id, teacherCode: `TC-${id}` }));
    const d1 = dako({ dakoId: "d1", dakoCode: "DK-001" });
    const d2 = dako({ dakoId: "d2", dakoCode: "DK-002" });
    const plan = allocate(bigCtx(t, [d1, d2], []));
    // 3 teachers, 4 SUGO+RESERBA slots → all SUGO+RESERBA filled, RESERBA_II starves.
    expect(plan.summary.sugoAssigned).toBe(2);
    expect(plan.summary.reserbaAssigned).toBe(1);
    expect(plan.summary.reserbaIiAssigned).toBe(0);
    expect(plan.slots.filter((s) => s.reasonCode === "INSUFFICIENT_FOR_RESERBA_II").length).toBe(2);
  });

  it("unassigned reason taxonomy surfaces absence/language causes (§11)", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const d = dako({ language: "ENGLISH" }); // Filipino-only teacher cannot serve
    const c = bigCtx([a], [d], []);
    const plan = allocate(c);
    const sugo = plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBeNull();
    expect(sugo.reasonCode).toBe("LANGUAGE_MISMATCH");
  });

  it("prev-week-absent exhaustion reports ALL_ABSENT_LAST_WEEK", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const d = dako();
    const c = bigCtx([a], [d], []);
    c.prevWeekAbsent = new Set(["a"]);
    const plan = allocate(c);
    const sugo = plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBeNull();
    expect(sugo.reasonCode).toBe("ALL_ABSENT_LAST_WEEK");
  });

  it("DISABLED dakos get no slots at all (§4.B)", () => {
    const a = teacher({ teacherId: "a", teacherCode: "TC-A" });
    const d1 = dako({ dakoId: "d1", dakoCode: "DK-001", status: "DISABLED" });
    const plan = allocate(bigCtx([a], [d1], []));
    expect(plan.slots).toHaveLength(0);
    expect(plan.summary.dakos).toBe(0);
  });

  it("is deterministic: identical context → identical plan (§12)", () => {
    const teachers = ["a", "b", "c"].map((id) => teacher({ teacherId: id, teacherCode: `TC-${id}` }));
    const dakos = ["d1", "d2"].map((id) => dako({ dakoId: id, dakoCode: `DK-${id}` }));
    const c1 = bigCtx(teachers, dakos, []);
    const c2 = bigCtx(teachers, dakos, []);
    expect(allocate(c1)).toEqual(allocate(c2));
  });
});
