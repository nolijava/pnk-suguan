import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";
import { FormField, SelectField, TextAreaField, Notice, ConfirmSubmit, UnsavedBack } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].map((d) => ({
  value: d,
  label: d.charAt(0) + d.slice(1).toLowerCase(),
}));

export default async function NewDakoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("dako.write");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  // Update #11 — "+ Add Another Dako": saved flag lands on a fresh form.
  const added = sp.added === "1";

  async function action(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("dako.write");
      const get = (k: string) => String(formData.get(k) ?? "").trim();
      await DakoService.createDako(
        {
          // Phase 6 §23 — dakoCode omitted: server auto-generates from the
          // concurrency-safe sequence (ILGD-###).
          name: get("name"),
          address: get("address"),
          dateEstablished: get("dateEstablished"),
          isPriority: formData.get("isPriority") === "on",
          worshipDay: get("worshipDay") as "SUNDAY",
          worshipTime: get("worshipTime"),
          language: get("language") as "FILIPINO" | "ENGLISH",
          remarks: get("remarks") || undefined,
        },
        actor,
      );
      // Update #11 — save first, then stay in the create workflow (fresh form).
      if (formData.get("next") === "another") {
        redirect("/dako/new?added=1");
      }
      redirect(`/dako?notice=${encodeURIComponent("Dako created.")}`);
    } catch (e) {
      if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e; // let success redirects propagate
      redirect(`/dako/new?error=${encodeURIComponent(e instanceof Error ? e.message : "Create failed")}`);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Add Dako</h1>
        <Link className="btn btn-secondary" href="/dako">Back to list</Link>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {added ? <Notice kind="success">Dako created — add another below.</Notice> : null}
      <UnsavedBack href="/dako" />
      <form action={action} className="card form-col">
        <div className="form-grid">
          {/* Phase 6 §23 — Dako Code is auto-generated (ILGD-###, concurrency-safe); not user-editable. */}
          <p className="info-note form-span">Dako Code is assigned automatically (next ILGD-###) when the dako is created.</p>
          <FormField label="Dako Name" name="name" required />
          <FormField label="Address" name="address" required />
          <FormField label="Date Established" name="dateEstablished" type="date" required />
          <p className="form-span"><label><input type="checkbox" name="isPriority" /> Priority Dako</label> <span className="info-note">Multiple dakos may be Priority — Priority dakos receive RESERBA assignment priority first (Update #6).</span></p>
          <SelectField label="Worship Day" name="worshipDay" required options={DAY_OPTIONS} />
          <FormField label="Worship Time" name="worshipTime" type="time" required placeholder="09:00" />
          <SelectField
            label="Language"
            name="language"
            required
            options={[{ value: "FILIPINO", label: "Filipino" }, { value: "ENGLISH", label: "English" }]}
          />
          <TextAreaField label="Remarks" name="remarks" />
        </div>
        <p className="info-note">
          Anniversary year count is always computed from Date Established — never stored as editable data.
        </p>
        <div className="actions-row">
          <ConfirmSubmit
            label="Create Dako"
            confirmTitle="Create Dako"
            confirmDescription="Create a new Dako record with the entered data."
            confirmLabel="Create"
            summaryFields={[
              { name: "name", label: "Dako Name" },
              { name: "address", label: "Address" },
              { name: "language", label: "Language" },
            ]}
          />
          <ConfirmSubmit
            label="+ Add Another Dako"
            confirmTitle="Create Dako and Add Another"
            confirmDescription="Create this Dako record, then return to a blank form for the next one."
            confirmLabel="Create and continue"
            variant="secondary"
            submitName="next"
            submitValue="another"
            summaryFields={[{ name: "name", label: "Dako Name" }]}
          />
          <UnsavedBack href="/dako" />
        </div>
      </form>
    </>
  );
}
