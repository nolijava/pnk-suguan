/**
 * Guro Duty × Magtuturo — pure rotation helper: the per-dako candidate queues
 * (each already carrying its within-dako fair rotation) are interleaved so
 * week-level teaching seats are shared fairly ACROSS dakos. No DB.
 */
import { describe, it, expect } from "vitest";
import { roundRobinByDako } from "@/server/services/magtuturo.service";

describe("roundRobinByDako — fair share across dako rosters", () => {
  it("interleaves level 0 of every dako first, then level 1 (round-robin)", () => {
    expect(
      roundRobinByDako([
        ["a1", "a2", "a3", "a4"],
        ["b1", "b2", "b3", "b4"],
      ]),
    ).toEqual(["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4"]);
  });

  it("uneven rosters never block the smaller dako from its share", () => {
    expect(
      roundRobinByDako([
        ["a1", "a2", "a3"],
        ["b1"],
        ["c1", "c2"],
      ]),
    ).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
  });

  it("handles empty queues and preserves the caller's dako order", () => {
    expect(roundRobinByDako([[], ["b1"], []])).toEqual(["b1"]);
    expect(roundRobinByDako([])).toEqual([]);
  });

  it("is deterministic — identical queues give identical order", () => {
    const q = [
      ["a1", "a2"],
      ["b1", "b2"],
    ];
    expect(roundRobinByDako(q)).toEqual(roundRobinByDako(q));
  });
});
