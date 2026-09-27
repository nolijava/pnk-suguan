import { describe, expect, it } from "vitest";
import {
  compareMagtuturoRotation,
  type MagtuturoRotationCandidate,
} from "@/server/services/magtuturo.service";

function candidate(
  teacherId: string,
  count: number,
  lastAssignment: number,
): MagtuturoRotationCandidate {
  return { teacherId, count, lastAssignment };
}

describe("Magtuturo fair-rotation ordering", () => {
  it("prioritizes the lowest cumulative Magtuturo assignment count", () => {
    const ordered = [
      candidate("teacher-c", 3, 1),
      candidate("teacher-b", 1, 100),
      candidate("teacher-a", 2, 1),
    ].sort(compareMagtuturoRotation);

    expect(ordered.map((teacher) => teacher.teacherId)).toEqual([
      "teacher-b",
      "teacher-a",
      "teacher-c",
    ]);
  });

  it("ranks the older last Magtuturo assignment first when counts are equal", () => {
    const older = candidate("teacher-z-older", 2, Date.parse("2024-01-10T12:00:00Z"));
    const newer = candidate("teacher-a-newer", 2, Date.parse("2024-01-20T12:00:00Z"));

    expect([newer, older].sort(compareMagtuturoRotation)).toEqual([older, newer]);
    expect(compareMagtuturoRotation(older, newer)).toBeLessThan(0);
  });

  it("ranks teachers with no Magtuturo history before teachers with history", () => {
    const neverAssigned = candidate("teacher-never", 0, 0);
    const assignedEarlier = candidate("teacher-assigned", 1, Date.parse("2020-01-01T00:00:00Z"));

    expect(compareMagtuturoRotation(neverAssigned, assignedEarlier)).toBeLessThan(0);
  });

  it("uses the teacher identifier as a deterministic final tie-break", () => {
    const first = candidate("teacher-a", 2, 123);
    const second = candidate("teacher-b", 2, 123);

    expect(compareMagtuturoRotation(first, second)).toBeLessThan(0);
    expect(compareMagtuturoRotation(second, first)).toBeGreaterThan(0);
  });
});
