import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService, DakoService } from "@/server/services";
import { FormField, SelectField, TextAreaField, Notice } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

export default async function NewTeacherPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("teachers.write");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const dakoList = await DakoService.listDako({ status: "ACTIVE", pageSize: 100 });

  async function action(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("teachers.write");
      const get = (k: string) => String(formData.get(k) ?? "").trim();
      const teacher = await TeacherService.createTeacher(
        {
          teacherCode: get("teacherCode"),
          firstName: get("firstName"),
          middleName: get("middleName") || undefined,
          lastName: get("lastName"),
          birthday: get("birthday") || undefined,
          purokGrupo: get("purokGrupo") || undefined,
          dateOfOath: get("dateOfOath") || undefined,
          currentDestinationId: get("currentDestinationId") || undefined,
          language: (get("language") || "FILIPINO") as "FILIPINO" | "ENGLISH",
          remarks: get("remarks") || undefined,
        },
        actor,
      );
      revalidatePath("/teachers");
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
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form action={action} className="card form-col">
        <div className="form-grid">
          <FormField label="Teacher Code" name="teacherCode" required />
          <FormField label="First Name" name="firstName" required />
          <FormField label="Middle Name" name="middleName" />
          <FormField label="Last Name" name="lastName" required />
          <FormField label="Birthday" name="birthday" type="date" />
          <FormField label="Purok/Grupo" name="purokGrupo" />
          <FormField label="Date of Oath" name="dateOfOath" type="date" />
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
          <button type="submit" className="btn btn-primary">Create Teacher</button>
          <Link className="btn btn-secondary" href="/teachers">Cancel</Link>
        </div>
      </form>
    </>
  );
}
