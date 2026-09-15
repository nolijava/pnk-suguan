import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService, TeacherService, WeekService } from "@/server/services";
import { isoWeek } from "@/lib/iso-week";

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("availability.read");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  const now = new Date();
  const cur = isoWeek(now);
  const year = Number(sp.year ?? cur.year);
  const weekNum = Number(sp.week ?? cur.week);
  const week = await WeekService.getOrCreateWeek(year, weekNum);
  const teachers = (await TeacherService.listTeachers({ status: "ACTIVE", pageSize: 100 })).rows;
  const avail = await AvailabilityService.listAvailabilityForWeek(week.id);
  const byTeacher = new Map(avail.map((a) => [a.teacherId, a]));

  async function action(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("availability.write");
      await AvailabilityService.upsertAvailability(
        {
          teacherId: String(formData.get("teacherId")),
          weekId: String(formData.get("weekId")),
          availabilityStatus: String(formData.get("availabilityStatus")) as "AVAILABLE" | "ABSENT" | "INACTIVE",
          reason: String(formData.get("reason") ?? "").trim() || undefined,
        },
        actor,
      );
      revalidatePath("/availability");
    } catch (e) {
      const { redirect } = await import("next/navigation");
      redirect(`/availability?error=${encodeURIComponent(e instanceof Error ? e.message : "operation failed")}`);
    }
  }

  return (
    <>
      <h1>Availability — Week {week.isoWeekNumber}, {week.year}</h1>
      <p style={{ color: "#555" }}>
        {week.startDate} → {week.endDate} · status {week.status}
      </p>
      {error ? <p className="error">{error}</p> : null}
      <table>
        <thead>
          <tr><th>Teacher</th><th>Status this week</th><th>Reason</th><th>Set</th></tr>
        </thead>
        <tbody>
          {teachers.map((t) => {
            const a = byTeacher.get(t.id);
            return (
              <tr key={t.id}>
                <td>{t.firstName} {t.lastName}</td>
                <td>{a?.availabilityStatus ?? "—"}</td>
                <td>{a?.reason ?? ""}</td>
                <td>
                  <form action={action} className="inline" style={{ padding: 0, border: "none" }}>
                    <input type="hidden" name="teacherId" value={t.id} />
                    <input type="hidden" name="weekId" value={week.id} />
                    <select name="availabilityStatus" defaultValue={a?.availabilityStatus ?? "AVAILABLE"}>
                      <option value="AVAILABLE">Available</option>
                      <option value="ABSENT">Absent</option>
                      <option value="INACTIVE">Inactive</option>
                    </select>
                    <input name="reason" placeholder="reason (required for absent)" />
                    <button type="submit">Save</button>
                  </form>
                </td>
              </tr>
            );
          })}
          {teachers.length === 0 ? <tr><td colSpan={4}>No active teachers yet.</td></tr> : null}
        </tbody>
      </table>
    </>
  );
}
