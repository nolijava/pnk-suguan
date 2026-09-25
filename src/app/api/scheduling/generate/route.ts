import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { ValidationError } from "@/lib/errors";
import { AvailabilityService, SchedulingService, WeekService } from "@/server/services";
import type { SessionUser } from "@/server/auth/session";

const GENERATION_MODES = ["auto", "manual", "destinado", "katuwang"] as const;
type GenerationMode = (typeof GENERATION_MODES)[number];

/**
 * §13 — generate (or regenerate) the AUTO schedule for a DRAFT week.
 *
 * Update #19 — the dashboard dropdown modal addresses the week as
 * `{ year, week }` (auto-created DRAFT via resolveWeek) as well as by
 * `{ weekId }`. Generation always LEAVES THE WEEK IN DRAFT — it never
 * finalizes or publishes.
 *
 * Guro Duty — the modal's Assign Destinado / Assign Katuwang options execute
 * the duty-based generation modes (`mode: "destinado" | "katuwang"`), enforced
 * server-side here (never frontend filtering). Same DRAFT lifecycle and hard
 * eligibility rules as Auto-generate.
 *
 * Update #22 — WEEKLY AVAILABILITY PREREQUISITE. No mode generates or persists
 * anything until the SELECTED week's required availability is encoded. The gate
 * runs BEFORE the week row is created and BEFORE any generation, so a blocked
 * attempt changes nothing and is audited (GENERATION_BLOCKED) by the gate
 * itself. `mode: "manual"` is gate-only: it validates and returns without
 * persisting anything — the dashboard's Manual method opens the Weekly Schedule
 * for hand encoding, and that navigation is granted only when the gate passes.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("scheduling.generate");
    const body = await parseBody<{ weekId?: string; year?: number; week?: number; mode?: string }>(req);
    const mode = (body.mode ?? "auto").toLowerCase();
    if (!GENERATION_MODES.includes(mode as GenerationMode)) {
      throw new ValidationError("unknown generation mode (use auto, manual, destinado or katuwang)");
    }

    if (body.weekId) {
      const week = await WeekService.getWeek(body.weekId);
      await AvailabilityService.assertGenerationAvailability({ weekId: week.id }, user, mode);
      return gateOrGenerate(mode as GenerationMode, week, user);
    }

    if (typeof body.year !== "number" || typeof body.week !== "number") {
      throw new ValidationError("provide either weekId or {year, week}");
    }
    // Update #22 — validate the SELECTED week FIRST. The gate is read-only, so a
    // blocked attempt must not leave an empty week row behind.
    await AvailabilityService.assertGenerationAvailability(
      { year: body.year, week: body.week },
      user,
      mode,
    );
    const week = await WeekService.resolveWeek({ year: body.year, week: body.week });
    return gateOrGenerate(mode as GenerationMode, week, user);
  } catch (err) {
    return fail(err);
  }
}

type WeekRow = Awaited<ReturnType<typeof WeekService.resolveWeek>>;

/** The gate has passed: Manual is a no-op acknowledgement, the rest generate. */
function gateOrGenerate(mode: GenerationMode, week: WeekRow, user: SessionUser) {
  if (mode === "manual") {
    return ok({ weekId: week.id, year: week.year, week: week.isoWeekNumber, manual: true });
  }
  if (mode === "destinado") {
    return SchedulingService.generateDutySchedule(week.id, "ASSIGN_DESTINADO", user).then((r) =>
      ok(r, 201),
    );
  }
  if (mode === "katuwang") {
    return SchedulingService.generateDutySchedule(week.id, "ASSIGN_KATUWANG", user).then((r) =>
      ok(r, 201),
    );
  }
  return SchedulingService.generateSchedule(week.id, user).then((r) => ok(r, 201));
}
