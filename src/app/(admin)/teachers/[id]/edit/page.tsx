import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService, DakoService } from "@/server/services";
import { FormField, SelectField, TextAreaField, Notice, StatusBadge } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

export default async function EditTeacherPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("teachers.write");
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const details = await TeacherService.getTeacherDetails(id);
  const t = details.teacher;
  const dakoList = await DakoService.listDako({ status: "ACTIVE", pageSize: 100 });

  async function saveAction(formData: FormData) {
    "use server";
    try {
      const actor = await requirePermission("teachers.write");
      const get = (k: string) => String(formData.get(k) ?? "").trim();
      await TeacherService.updateTeacher(
        id,
        {
          teacherCode: get("teacherCode"),
          firstName: get("firstName"),
          middleName: get("middleName") || undefined,
          lastName: get("lastName"),
          birthday: get("birthday") || undefined,
          purokGrupo: get("purokGrupo") || undefined,
          dateOfOath: get("dateOfOath") || undefined,
          language: get("language") as "FILIPINO" | "ENGLISH",
          remarks: get("remarks") || undefined,
        },
        actor,
      );
      revalidatePath(`/teachers/${id}`);
      redirect(`/teachers/${id}?notice=${encodeURIComponent("Teacher updated.")}`);
    } catch (e) {
      if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
      redirect(`/teachers/${id}/edit?error=${encodeURIComponent(e instanceof Error ? e.message : "Update failed")}`);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>
          Edit Teacher — {t.teacherCode} <StatusBadge status={t.status} />
        </h1>
        <Link className="btn btn-secondary" href={`/teachers/${id}`}>Back to details</Link>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form action={saveAction} className="card form-col">
        <div className="form-grid">
          <FormField label="Teacher Code" name="teacherCode" required defaultValue={t.teacherCode} />
          <FormField label="First Name" name="firstName" required defaultValue={t.firstName} />
          <FormField label="Middle Name" name="middleName" defaultValue={t.middleName} />
          <FormField label="Last Name" name="lastName" required defaultValue={t.lastName} />
          <FormField label="Birthday" name="birthday" type="date" defaultValue={t.birthday} />
          <FormField label="Purok/Grupo" name="purokGrupo" defaultValue={t.purokGrupo} />
          <FormField label="Date of Oath" name="dateOfOath" type="date" defaultValue={t.dateOfOath} />
          <SelectField
            label="Language"
            name="language"
            required
            defaultValue={t.language}
            options={[{ value: "FILIPINO", label: "Filipino" }, { value: "ENGLISH", label: "English" }]}
          />
          <TextAreaField label="Remarks" name="remarks" defaultValue={t.remarks} />
        </div>
        <p className="info-note">
          Current Destination is managed from the details page (set/change/clear are audited separately).
          Status changes use Deactivate/Reactivate with confirmation.
        </p>
        <div className="actions-row">
          <button type="submit" className="btn btn-primary">Save Changes</button>
          <Link className="btn btn-secondary" href={`/teachers/${id}`}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
