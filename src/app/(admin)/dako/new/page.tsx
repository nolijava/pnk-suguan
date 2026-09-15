import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";
import { FormField, SelectField, TextAreaField, Notice } from "@/app/(admin)/_components";

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

  async function action(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("dako.write");
      const get = (k: string) => String(formData.get(k) ?? "").trim();
      await DakoService.createDako(
        {
          dakoCode: get("dakoCode"),
          name: get("name"),
          address: get("address"),
          dateEstablished: get("dateEstablished"),
          purokGrupo: get("purokGrupo") || undefined,
          worshipDay: get("worshipDay") as "SUNDAY",
          worshipTime: get("worshipTime"),
          language: get("language") as "FILIPINO" | "ENGLISH",
          remarks: get("remarks") || undefined,
        },
        actor,
      );
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
      <form action={action} className="card form-col">
        <div className="form-grid">
          <FormField label="Dako Code" name="dakoCode" required />
          <FormField label="Dako Name" name="name" required />
          <FormField label="Address" name="address" required />
          <FormField label="Date Established" name="dateEstablished" type="date" required />
          <FormField label="Purok/Grupo" name="purokGrupo" />
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
          <button type="submit" className="btn btn-primary">Create Dako</button>
          <Link className="btn btn-secondary" href="/dako">Cancel</Link>
        </div>
      </form>
    </>
  );
}
