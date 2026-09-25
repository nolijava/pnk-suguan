/**
 * Guro Duty (Destinado / Katuwang) Update — pure planner unit tests:
 * mode slot layouts, per-dako fair rotation (#5–#9), hard-rule supremacy
 * (#10), roster/dako boundaries (#11), MANUAL-slot immovability (#14) and
 * determinism (#7). No DB — plain context objects like the rest of the core.
 */
import { describe, it, expect } from "vitest";
import {
  planDutyAssignments,
  zeroRotation,
  type DutyPlan,
  type DutyRotationStats,
} from "@/server/services/scheduling/duty";
import type {
  CandidateTeacher,
  SchedulingContext,
  ScheduleDako,
  AssignmentType,
} from "@/server/services/scheduling/types";

function teacher(over: Partial<CandidateTeacher> = {}): CandidateTeacher {
  return {
    teacherId: "t1",
    teacherCode: "TC-001",
    fullName: "One Teacher",
    language: "FILIPINO",
    status: "ACTIVE",
    currentDestinationId: "d1",
    dateOfOath: null,
    duty: null,
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
    isPriority: false,
    ...over,
  };
}

function ctx(over: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    weekId: "w1",
    year: 2026,
    isoWeekNumber: 40,
    weekStatus: "DRAFT",
    weekServiceDate: "2026-10-04",
    teachers: [],
    dakos: [dako()],
    availability: new Map(),
    prevWeekAbsent: new Set(),
    counts: new Map(),
    weekAssignments: new Map(),
    immovableTeachers: new Set(),
    occupiedSlots: new Set(),
    prevWeekAssignment: new Map(),
    ...over,
  };
}

function avail(teachers: CandidateTeacher[]): SchedulingContext["availability"] {
  return new Map(teachers.map((t) => [t.teacherId, { status: "AVAILABLE", reason: null }]));
}

function rot(entries: [string, Partial<DutyRotationStats>][]): Map<string, DutyRotationStats> {
  return new Map(entries.map(([k, v]) => [k, { ...zeroRotation(), ...v }]));
}

function slot(plan: DutyPlan, type: AssignmentType) {
  return plan.slots.find((s) => s.assignmentType === type)!;
}

// One dako's standard roster: one Destinado + two Katuwang, all assigned to d1.
function roster3(): CandidateTeacher[] {
  return [
    teacher({ teacherId: "a", teacherCode: "TC-01", fullName: "Dest A", duty: "DESTINADO" }),
    teacher({ teacherId: "b", teacherCode: "TC-02", fullName: "Kat B", duty: "KATUWANG" }),
    teacher({ teacherId: "c", teacherCode: "TC-03", fullName: "Kat C", duty: "KATUWANG" }),
  ];
}

describe("duty modes — slot layout (#3/#4)", () => {
  it("ASSIGN_DESTINADO: Destinado → SUGO, Katuwang → RESERBA, extra Katuwang → RESERBA_II", () => {
    const ts = roster3();
    const plan = planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_DESTINADO", new Map());
    expect(plan.applicableDakos).toBe(1);
    expect(plan.inserted).toBe(3);
    expect(slot(plan, "SUGO")).toMatchObject({ teacherId: "a", duty: "DESTINADO" });
    expect(slot(plan, "RESERBA")).toMatchObject({ teacherId: "b", duty: "KATUWANG" });
    expect(slot(plan, "RESERBA_II")).toMatchObject({ teacherId: "c", duty: "KATUWANG" });
  });

  it("ASSIGN_KATUWANG: Katuwang → SUGO, Destinado → RESERBA, extra Katuwang → RESERBA_II", () => {
    const ts = roster3();
    const plan = planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_KATUWANG", new Map());
    expect(slot(plan, "SUGO")).toMatchObject({ teacherId: "b", duty: "KATUWANG" });
    expect(slot(plan, "RESERBA")).toMatchObject({ teacherId: "a", duty: "DESTINADO" });
    expect(slot(plan, "RESERBA_II")).toMatchObject({ teacherId: "c", duty: "KATUWANG" });
  });
});

describe("fair rotation (#5/#7) — never the same first Katuwang", () => {
  it("two Katuwang: second use swaps SUGO and RESERBA_II (spec example)", () => {
    const ts = roster3();
    // First use happened: Kat B took SUGO once.
    const history = rot([["b|d1", { sugoPicks: 1, reserbaIiPicks: 0, lastPickedAt: "2026-09-20" }]]);
    const plan = planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_KATUWANG", history);
    expect(slot(plan, "SUGO").teacherId).toBe("c"); // C: fewer SUGO picks
    expect(slot(plan, "RESERBA").teacherId).toBe("a");
    expect(slot(plan, "RESERBA_II").teacherId).toBe("b"); // B rotates to RESERBA_II
  });

  it("three Katuwang rotate evenly through SUGO — D participates too", () => {
    const ts = [
      teacher({ teacherId: "a", teacherCode: "TC-01", fullName: "Dest A", duty: "DESTINADO" }),
      teacher({ teacherId: "b", teacherCode: "TC-02", fullName: "Kat B", duty: "KATUWANG" }),
      teacher({ teacherId: "c", teacherCode: "TC-03", fullName: "Kat C", duty: "KATUWANG" }),
      teacher({ teacherId: "d", teacherCode: "TC-04", fullName: "Kat D", duty: "KATUWANG" }),
    ];
    const base = () => ctx({ teachers: ts, availability: avail(ts) });

    // Use 1 (fresh): B takes SUGO (stable code tie-break), C RESERBA_II, D waits.
    const r1 = planDutyAssignments(base(), "ASSIGN_KATUWANG", new Map());
    expect(slot(r1, "SUGO").teacherId).toBe("b");
    expect(slot(r1, "RESERBA_II").teacherId).toBe("c");

    // Use 2: D has served nobody → D takes SUGO; B (fewer RESERBA_II picks than
    // C) rotates to RESERBA_II. C waits for the SUGO turn.
    const r2 = planDutyAssignments(
      base(),
      "ASSIGN_KATUWANG",
      rot([
        ["b|d1", { sugoPicks: 1, reserbaIiPicks: 0, lastPickedAt: "2026-09-20" }],
        ["c|d1", { sugoPicks: 0, reserbaIiPicks: 1, lastPickedAt: "2026-09-20" }],
      ]),
    );
    expect(slot(r2, "SUGO").teacherId).toBe("d");
    expect(slot(r2, "RESERBA_II").teacherId).toBe("b");

    // Use 3: C has never been SUGO → C takes SUGO; D rotates to RESERBA_II.
    const r3 = planDutyAssignments(
      base(),
      "ASSIGN_KATUWANG",
      rot([
        ["b|d1", { sugoPicks: 1, reserbaIiPicks: 1, lastPickedAt: "2026-09-27" }],
        ["c|d1", { sugoPicks: 0, reserbaIiPicks: 1, lastPickedAt: "2026-09-20" }],
        ["d|d1", { sugoPicks: 1, reserbaIiPicks: 0, lastPickedAt: "2026-09-27" }],
      ]),
    );
    expect(slot(r3, "SUGO").teacherId).toBe("c");
    expect(slot(r3, "RESERBA_II").teacherId).toBe("d");

    // Everyone served exactly twice across the three uses — even rotation.
    const serves: Record<string, number> = { b: 0, c: 0, d: 0 };
    for (const p of [r1, r2, r3]) {
      for (const s of p.slots) {
        if (s.assignmentType !== "RESERBA" && s.teacherId && s.teacherId in serves) {
          serves[s.teacherId] = (serves[s.teacherId] ?? 0) + 1;
        }
      }
    }
    expect(serves).toEqual({ b: 2, c: 2, d: 2 });
  });

  it("lower SUGO count wins; total service and recency break ties; teacherCode is the stable final tie-break", () => {
    const ts = roster3();
    // Equal SUGO counts → the one picked longest ago (B) wins over C.
    const recency = rot([
      ["b|d1", { sugoPicks: 1, lastPickedAt: "2026-01-01" }],
      ["c|d1", { sugoPicks: 1, lastPickedAt: "2026-06-01" }],
    ]);
    expect(
      slot(planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_KATUWANG", recency), "SUGO")
        .teacherId,
    ).toBe("b");
    // All-equal history → deterministic code order (and identical reruns).
    const fresh = () => planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_KATUWANG", new Map());
    expect(fresh()).toEqual(fresh());
    expect(slot(fresh(), "SUGO").teacherId).toBe("b");
  });

  it("ASSIGN_DESTINADO rotates fairly between multiple Destinado (#9)", () => {
    const ts = [
      teacher({ teacherId: "a", teacherCode: "TC-01", duty: "DESTINADO" }),
      teacher({ teacherId: "b", teacherCode: "TC-02", duty: "DESTINADO" }),
      teacher({ teacherId: "c", teacherCode: "TC-03", duty: "KATUWANG" }),
    ];
    const history = rot([["a|d1", { sugoPicks: 3, lastPickedAt: "2026-09-20" }]]);
    const plan = planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_DESTINADO", history);
    expect(slot(plan, "SUGO").teacherId).toBe("b"); // fewer SUGO picks wins
    expect(slot(plan, "RESERBA").teacherId).toBe("c");
  });
});

describe("per-dako fairness (#8) and boundaries (#11)", () => {
  it("each dako rotates among its OWN Katuwang — histories never mix", () => {
    const ts = [
      teacher({ teacherId: "a1", teacherCode: "TC-A1", duty: "DESTINADO", currentDestinationId: "d1" }),
      teacher({ teacherId: "a2", teacherCode: "TC-A2", duty: "KATUWANG", currentDestinationId: "d1" }),
      teacher({ teacherId: "a3", teacherCode: "TC-A3", duty: "KATUWANG", currentDestinationId: "d1" }),
      teacher({ teacherId: "b1", teacherCode: "TC-B1", duty: "DESTINADO", currentDestinationId: "d2" }),
      teacher({ teacherId: "b2", teacherCode: "TC-B2", duty: "KATUWANG", currentDestinationId: "d2" }),
      teacher({ teacherId: "b3", teacherCode: "TC-B3", duty: "KATUWANG", currentDestinationId: "d2" }),
    ];
    const c = ctx({
      teachers: ts,
      availability: avail(ts),
      dakos: [dako({ dakoId: "d1", dakoCode: "DK-001" }), dako({ dakoId: "d2", dakoCode: "DK-002" })],
    });
    // a2 is far behind at d1 — that must NOT influence d2's rotation at all.
    const plan = planDutyAssignments(
      c,
      "ASSIGN_KATUWANG",
      rot([["a2|d1", { sugoPicks: 5, lastPickedAt: "2026-09-20" }]]),
    );
    expect(plan.applicableDakos).toBe(2);
    expect(slot(plan, "SUGO").teacherId).toBe("a3"); // d1: a2 penalized
    const d2Sugo = plan.slots.find((s) => s.dakoId === "d2" && s.assignmentType === "SUGO")!;
    expect(d2Sugo.teacherId).toBe("b2"); // d2: fresh code-order rotation
    // Week-wide single use: every teacher serves exactly one slot.
    const assigned = plan.slots.map((s) => s.teacherId).filter(Boolean);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.length).toBe(6);
  });

  it("a dako with no duty roster gets no slots — teachers are never borrowed cross-dako", () => {
    const ts = [
      teacher({ teacherId: "a", teacherCode: "TC-01", duty: "DESTINADO", currentDestinationId: "d1" }),
      teacher({ teacherId: "b", teacherCode: "TC-02", duty: "KATUWANG", currentDestinationId: "d1" }),
      teacher({ teacherId: "c", teacherCode: "TC-03", duty: "KATUWANG", currentDestinationId: "d1" }),
    ];
    const plan = planDutyAssignments(
      ctx({
        teachers: ts,
        availability: avail(ts),
        dakos: [dako({ dakoId: "d1", dakoCode: "DK-001" }), dako({ dakoId: "d2", dakoCode: "DK-002" })],
      }),
      "ASSIGN_KATUWANG",
      new Map(),
    );
    expect(plan.applicableDakos).toBe(1);
    expect(plan.slots.every((s) => s.dakoId === "d1")).toBe(true);
  });

  it("teachers without a recorded duty are excluded — duty is never inferred (#15)", () => {
    const ts = [
      teacher({ teacherId: "a", teacherCode: "TC-01", duty: null }),
      teacher({ teacherId: "b", teacherCode: "TC-02", duty: undefined }),
    ];
    const plan = planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_KATUWANG", new Map());
    expect(plan.applicableDakos).toBe(0);
    expect(plan.slots).toHaveLength(0);
  });
});

describe("hard eligibility outranks duty (#10)", () => {
  it("an oath-date-blocked Destinado is never replaced by a Katuwang in its SUGO", () => {
    const ts = [
      teacher({ teacherId: "a", teacherCode: "TC-01", duty: "DESTINADO", dateOfOath: "2099-01-01" }),
      teacher({ teacherId: "b", teacherCode: "TC-02", duty: "KATUWANG" }),
    ];
    const plan = planDutyAssignments(ctx({ teachers: ts, availability: avail(ts) }), "ASSIGN_DESTINADO", new Map());
    const sugo = slot(plan, "SUGO");
    expect(sugo.teacherId).toBeNull();
    expect(sugo.duty).toBe("DESTINADO");
    expect(sugo.reasonCode).toBe("NO_ELIGIBLE_CANDIDATES");
    expect(sugo.reason).toContain("OATH_DATE_NOT_REACHED");
    // The Katuwang still takes RESERBA — duty preference never violates rules.
    expect(slot(plan, "RESERBA").teacherId).toBe("b");
    expect(slot(plan, "RESERBA_II").teacherId).toBeNull();
  });

  it("weekly ABSENT / NOT_ENCODED / language violations exclude duty holders honestly", () => {
    const ts = [
      teacher({ teacherId: "a", teacherCode: "TC-01", duty: "DESTINADO" }),
      teacher({ teacherId: "b", teacherCode: "TC-02", duty: "KATUWANG" }),
    ];
    // ABSENT Destinado
    const absent = planDutyAssignments(
      ctx({ teachers: ts, availability: new Map([["a", { status: "ABSENT", reason: "travel" }], ["b", { status: "AVAILABLE", reason: null }]]) }),
      "ASSIGN_DESTINADO",
      new Map(),
    );
    expect(slot(absent, "SUGO").reason).toContain("WEEKLY_ABSENT");
    // NOT_ENCODED Destinado (no availability record at all)
    const none = planDutyAssignments(
      ctx({ teachers: ts, availability: new Map([["b", { status: "AVAILABLE", reason: null }]]) }),
      "ASSIGN_DESTINADO",
      new Map(),
    );
    expect(slot(none, "SUGO").reason).toContain("NOT_ENCODED");
    // Filipino roster cannot serve an English dako
    const lang = planDutyAssignments(
      ctx({ teachers: ts, availability: avail(ts), dakos: [dako({ language: "ENGLISH" })] }),
      "ASSIGN_KATUWANG",
      new Map(),
    );
    expect(slot(lang, "SUGO").reason).toContain("LANGUAGE_MISMATCH");
  });
});

describe("MANUAL/OVERRIDE immovability (#14)", () => {
  it("slots occupied by MANUAL rows are skipped entirely", () => {
    const ts = roster3();
    const plan = planDutyAssignments(
      ctx({ teachers: ts, availability: avail(ts), occupiedSlots: new Set(["d1|SUGO"]) }),
      "ASSIGN_DESTINADO",
      new Map(),
    );
    expect(plan.slots.find((s) => s.assignmentType === "SUGO")).toBeUndefined();
    expect(slot(plan, "RESERBA").teacherId).toBe("b");
    expect(slot(plan, "RESERBA_II").teacherId).toBe("c");
    expect(plan.inserted).toBe(2);
  });
});
