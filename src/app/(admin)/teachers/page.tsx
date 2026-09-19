import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService, DakoService } from "@/server/services";
import { calculateAge } from "@/lib/anniversary";
import { teacherQuerySchema } from "@/lib/validation/query-schemas";
import { DataTable, StatusBadge, FilterForm, Pagination, ConfirmDialog } from "@/app/(admin)/_components";
import type { Column } from "@/app/(admin)/_components";
import type { TeacherListRow } from "@/server/services/teacher.service";

export const dynamic = "force-dynamic";

const TEACHER_FILTERS = [
  { name: "status", label: "Status", options: [{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }] },
  { name: "language", label: "Language", options: [{ value: "FILIPINO", label: "Filipino" }, { value: "ENGLISH", label: "English" }] },
];

export default async function TeachersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("teachers.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = teacherQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : {};
  const notice = typeof sp.notice === "string" ? sp.notice : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  // Current Destination filter dropdown: all dako the user can pick from.
  const dakoList = await DakoService.listDako({ pageSize: 100 });
  const canWrite = user.roleCodes.includes("ADMIN") || user.roleCodes.includes("SCHEDULER");

  const { rows, total, page, pageCount } = await TeacherService.listTeachers({
    search: query.q,
    status: query.status,
    language: query.language,
    currentDestinationId: query.currentDestinationId,
    sort: query.sort,
    order: query.order,
    page: query.page,
    pageSize: query.pageSize,
  });

  async function deactivateAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("teachers.write");
    await TeacherService.deactivateTeacher(String(formData.get("id")), String(formData.get("reason")), actor);
    revalidatePath("/teachers");
    redirect(`/teachers?notice=${encodeURIComponent("Teacher deactivated.")}`);
  }
  async function reactivateAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("teachers.write");
    await TeacherService.reactivateTeacher(String(formData.get("id")), actor);
    revalidatePath("/teachers");
    redirect(`/teachers?notice=${encodeURIComponent("Teacher reactivated.")}`);
  }

  const columns: Column<TeacherListRow>[] = [
    {
      key: "code", header: "Teacher Code", sortKey: "code",
      render: (t) => <Link href={`/teachers/${t.id}`}>{t.teacherCode}</Link>,
    },
    {
      key: "name", header: "Full Name", sortKey: "name",
      render: (t) => (
        <span>
          {[t.firstName, t.middleName, t.lastName].filter(Boolean).join(" ")}
        </span>
      ),
    },
    {
      key: "birthday", header: "Birthday / Age", sortKey: "birthday",
      render: (t) => (t.birthday ? `${t.birthday} (${calculateAge(t.birthday)})` : "—"),
    },
    { key: "purok", header: "Purok/Grupo", render: (t) => t.purokGrupo ?? "—" },
    { key: "language", header: "Language", render: (t) => t.language },
    {
      key: "dest", header: "Current Destination",
      render: (t) =>
        t.currentDestinationName
          ? `${t.currentDestinationName}${t.currentDestinationStatus === "DISABLED" ? " (DISABLED)" : ""}`
          : "—",
    },
    { key: "status", header: "Status", sortKey: "status", render: (t) => <StatusBadge status={t.status} /> },
    { key: "oath", header: "Date of Oath", sortKey: "dateOfOath", render: (t) => t.dateOfOath ?? "—" },
    {
      key: "actions", header: "",
      render: (t) =>
        canWrite ? (
          <span className="actions-row" style={{ margin: 0 }}>
            <Link className="btn btn-secondary" href={`/teachers/${t.id}/edit`}>Edit</Link>
            {t.status === "ACTIVE" ? (
              <ConfirmDialog
                triggerLabel="Deactivate"
                className="btn btn-danger"
                title="Deactivate teacher"
                description={`Set ${t.firstName} ${t.lastName} (${t.teacherCode}) to Inactive? Historical records remain intact.`}
                confirmLabel="Deactivate"
                requireReason
                hiddenFields={{ id: t.id }}
                action={deactivateAction}
              />
            ) : (
              <ConfirmDialog
                triggerLabel="Reactivate"
                title="Reactivate teacher"
                description={`Set ${t.teacherCode} back to Active? Previous inactive periods remain in history.`}
                confirmLabel="Reactivate"
                hiddenFields={{ id: t.id }}
                action={reactivateAction}
              />
            )}
          </span>
        ) : null,
    },
  ];

  const baseSearch: Record<string, string | undefined> = {
    q: query.q,
    status: query.status,
    language: query.language,
    currentDestinationId: query.currentDestinationId,
    sort: query.sort,
    order: query.order,
    pageSize: query.pageSize ? String(query.pageSize) : undefined,
  };

  // Current Destination filter (3rd approved filter) — all dako, labeled with status.
  const destFilter = {
    name: "currentDestinationId",
    label: "Current Destination",
    options: dakoList.rows.map((d) => ({
      value: d.id,
      label: `${d.name}${d.status === "DISABLED" ? " (disabled)" : ""}`,
    })),
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Teachers</h1>
          <p>Master data — current state. History is preserved in the audit trail.</p>
        </div>
        {canWrite ? <Link className="btn btn-primary" href="/teachers/new">Add Teacher</Link> : null}
      </div>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {/* Filters apply as they change (no Apply button); sort/order/pageSize are
          preserved so filtering never silently drops the active sort. */}
      <FilterForm
        action="/teachers"
        fields={[
          { kind: "search", name: "q", placeholder: "Search code, first, middle, last, or full name…" },
          ...TEACHER_FILTERS,
          destFilter,
        ]}
        values={baseSearch}
        preserve={{
          sort: query.sort,
          order: query.order,
          pageSize: query.pageSize ? String(query.pageSize) : undefined,
        }}
      />

      <DataTable columns={columns} rows={rows} sort={query.sort} order={query.order} baseSearch={baseSearch}
        emptyMessage={query.q || query.status || query.language || query.currentDestinationId ? "No teachers match your filters." : "No teachers yet. Add the first teacher to get started."} />

      <Pagination page={page} pageCount={pageCount} total={total} baseSearch={baseSearch} basePath="/teachers" />
    </>
  );
}
