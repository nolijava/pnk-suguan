import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";
import { FormField, SelectField, TextAreaField, Notice, StatusBadge } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].map((d) => ({
  value: d,
  label: d.charAt(0) + d.slice(1).toLowerCase(),
}));

export default async function EditDakoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("dako.write");
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const details = await DakoService.getDakoDetails(id);
  const d = details.dako;

  async function saveAction(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("dako.write");
      const get = (k: string) => String(formData.get(k) ?? "").trim();
      await DakoService.updateDako(
        id,
        {
          // Phase 6 §23 — dakoCode omitted: immutable system-assigned code.
          name: get("name"),
          address: get("address"),
          dateEstablished: get("dateEstablished") || undefined,
          purokGrupo: get("purokGrupo") || undefined,
          worshipDay: get("worshipDay") as "SUNDAY",
          worshipTime: get("worshipTime"),
          language: get("language") as "FILIPINO" | "ENGLISH",
          remarks: get("remarks") || undefined,
        },
        actor,
      );
      revalidatePath(`/dako/${id}`);
      redirect(`/dako/${id}?notice=${encodeURIComponent("Dako updated.")}`);
    } catch (e) {
      if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
      redirect(`/dako/${id}/edit?error=${encodeURIComponent(e instanceof Error ? e.message : "Update failed")}`);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>
          Edit Dako — {d.dakoCode} <StatusBadge status={d.status} />
        </h1>
        <Link className="btn btn-secondary" href={`/dako/${id}`}>Back to details</Link>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form action={saveAction} className="card form-col">
        <div className="form-grid">
          {/* Phase 6 §23 — Dako Code is immutable; keep it visible read-only. */}
          <p className="info-note form-span">Dako Code: <strong>{d.dakoCode}</strong> (system-assigned, immutable)</p>
          <FormField label="Dako Name" name="name" required defaultValue={d.name} />
          <FormField label="Address" name="address" required defaultValue={d.address} />
          <FormField label="Date Established" name="dateEstablished" type="date" defaultValue={d.dateEstablished} />
          <FormField label="Purok/Grupo" name="purokGrupo" defaultValue={d.purokGrupo} />
          <SelectField label="Worship Day" name="worshipDay" required options={DAY_OPTIONS} defaultValue={d.worshipDay} />
          <FormField label="Worship Time" name="worshipTime" type="time" required defaultValue={d.worshipTime} />
          <SelectField
            label="Language"
            name="language"
            required
            defaultValue={d.language}
            options={[{ value: "FILIPINO", label: "Filipino" }, { value: "ENGLISH", label: "English" }]}
          />
          <TextAreaField label="Remarks" name="remarks" defaultValue={d.remarks} />
        </div>
        <p className="info-note">Status changes use Enable/Disable with confirmation and a required reason.</p>
        <div className="actions-row">
          <button type="submit" className="btn btn-primary">Save Changes</button>
          <Link className="btn btn-secondary" href={`/dako/${id}`}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
