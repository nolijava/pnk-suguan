import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { TeacherService, DakoService } from "@/server/services";
import { FormField, SelectField, TextAreaField, Notice, ConfirmSubmit, UnsavedBack } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

export default async function NewTeacherPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("teachers.write");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const added = typeof sp.added === "string";
  const dakoList = await DakoService.listDako({ status: "ACTIVE", pageSize: 100 });

  async function action(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("teachers.write");
      const get = (k: string) => String(formData.get(k) ?? "").trim();
      const teacher = await TeacherService.createTeacher(
        {
          // Phase 6 §20 — teacherCode omitted: server auto-generates from the
          // concurrency-safe sequence (PNK-G-####).
          firstName: get("firstName"),
          middleName: get("middleName") || undefined,
          lastName: get("lastName"),
          // Update #3 — optional Suffix is its own field (never part of Last Name).
          suffix: get("suffix") || null,
          birthday: get("birthday") || undefined,
          purokGrupo: get("purokGrupo") || undefined,
          dateOfOath: get("dateOfOath") || undefined,
          // Guro Duty — the form requires one of the two options.
          duty: (get("duty") || undefined) as "DESTINADO" | "KATUWANG" | undefined,
          currentDestinationId: get("currentDestinationId") || undefined,
          language: (get("language") || "FILIPINO") as "FILIPINO" | "ENGLISH",
          remarks: get("remarks") || undefined,
        },
        actor,
      );
      revalidatePath("/teachers");
      // Update #11 — "+ Add Another Guro": save first, then stay in the create
      // workflow with a blank form (fresh redirect — nothing leaks forward).
      if (formData.get("next") === "another") {
        redirect("/teachers/new?added=1");
      }
      redirect(`/teachers/${teacher.id}?notice=${encodeURIComponent("Teacher created.")}`);
    } catch (e) {
      if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e; // let success redirects propagate
      redirect(`/teachers/new?error=${encodeURIComponent(e instanceof Error ? e.message : "Create failed")}`);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Add Teacher</h1>
        <Link className="btn btn-secondary" href="/teachers">Back to list</Link>
      </div>
      {added ? <Notice kind="success">Teacher created. Ready for the next Guro.</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form action={action} className="card form-col">
        <div className="form-grid">
          {/* Phase 6 §20 — Teacher Code is auto-generated (PNK-G-####, concurrency-safe); not user-editable. */}
          <p className="info-note form-span">Teacher Code is assigned automatically (next PNK-G-####) when the teacher is created.</p>
          <FormField label="First Name" name="firstName" required />
          <FormField label="Middle Name" name="middleName" />
          <FormField label="Last Name" name="lastName" required />
          <FormField label="Suffix" name="suffix" placeholder="Jr. / Sr. / II / III" />
          <FormField label="Birthday" name="birthday" type="date" />
          <FormField label="Purok/Grupo" name="purokGrupo" />
          <FormField label="Date of Oath" name="dateOfOath" type="date" />
          {/* Guro Duty — required radio pair (exactly two options). */}
          <fieldset className="form-span duty-field">
            <legend>
              Duty<em aria-hidden="true"> *</em>
            </legend>
            <label>
              <input type="radio" name="duty" value="DESTINADO" required /> Destinado
            </label>{" "}
            <label>
              <input type="radio" name="duty" value="KATUWANG" required /> Katuwang
            </label>{" "}
            <span className="info-note">
              Guro role for duty-based generation (Assign Destinado / Assign Katuwang).
            </span>
          </fieldset>
          <SelectField
            label="Language"
            name="language"
            required
            options={[{ value: "FILIPINO", label: "Filipino" }, { value: "ENGLISH", label: "English" }]}
          />
          <SelectField
            label="Current Destination (ACTIVE dako only)"
            name="currentDestinationId"
            includeBlank="— none —"
            options={dakoList.rows.map((d) => ({ value: d.id, label: `${d.dakoCode} · ${d.name}` }))}
          />
          <TextAreaField label="Remarks" name="remarks" />
        </div>
        <p className="info-note">Age is always computed from Birthday and never stored.</p>
        <div className="actions-row">
          <ConfirmSubmit
            label="Create Teacher"
            confirmTitle="Create Teacher"
            confirmDescription="Create a new Guro record with the entered data."
            confirmLabel="Create"
            summaryFields={[
              { name: "firstName", label: "First Name" },
              { name: "middleName", label: "Middle Name" },
              { name: "lastName", label: "Last Name" },
              { name: "suffix", label: "Suffix" },
              { name: "duty", label: "Duty" },
              { name: "language", label: "Language" },
            ]}
          />
          <ConfirmSubmit
            label="+ Add Another Guro"
            confirmTitle="Create Teacher and Add Another"
            confirmDescription="Create this Guro record, then return to a blank form for the next one."
            confirmLabel="Create and continue"
            variant="secondary"
            submitName="next"
            submitValue="another"
            summaryFields={[
              { name: "firstName", label: "First Name" },
              { name: "lastName", label: "Last Name" },
            ]}
          />
          <UnsavedBack href="/teachers" />
        </div>
      </form>
    </>
  );
}
