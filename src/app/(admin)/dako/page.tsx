import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";
import { dakoQuerySchema } from "@/lib/validation/query-schemas";
import { DataTable, StatusBadge, FilterForm, Pagination, ConfirmDialog } from "@/app/(admin)/_components";
import type { Column } from "@/app/(admin)/_components";
import type { DakoListRow } from "@/server/services/dako.service";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].map((d) => ({
  value: d,
  label: d.charAt(0) + d.slice(1).toLowerCase(),
}));

const DAKO_FILTERS = [
  { name: "status", label: "Status", options: [{ value: "ACTIVE", label: "Active" }, { value: "DISABLED", label: "Disabled" }] },
  { name: "language", label: "Language", options: [{ value: "FILIPINO", label: "Filipino" }, { value: "ENGLISH", label: "English" }] },
];

export default async function DakoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("dako.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = dakoQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : {};
  const notice = typeof sp.notice === "string" ? sp.notice : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  const { rows, total, page, pageCount } = await DakoService.listDako({
    search: query.q,
    status: query.status,
    language: query.language,
    isPriority: query.isPriority,
    worshipDay: query.worshipDay,
    sort: query.sort,
    order: query.order,
    page: query.page,
    pageSize: query.pageSize,
  });
  const canWrite = user.roleCodes.includes("ADMIN") || user.roleCodes.includes("SCHEDULER");

  async function disableAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("dako.write");
    await DakoService.disableDako(String(formData.get("id")), String(formData.get("reason")), actor);
    revalidatePath("/dako");
    redirect(`/dako?notice=${encodeURIComponent("Dako disabled.")}`);
  }
  async function enableAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("dako.write");
    await DakoService.enableDako(String(formData.get("id")), actor);
    revalidatePath("/dako");
    redirect(`/dako?notice=${encodeURIComponent("Dako enabled.")}`);
  }

  const columns: Column<DakoListRow>[] = [
    {
      key: "code", header: "Dako Code", sortKey: "code",
      render: (d) => <Link href={`/dako/${d.id}`}>{d.dakoCode}</Link>,
    },
    { key: "name", header: "Dako Name", sortKey: "name", render: (d) => d.name },
    { key: "address", header: "Address", render: (d) => d.address },
    { key: "priority", header: "Priority", render: (d) => (d.isPriority ? "PRIORITY" : "—") },
    { key: "worship", header: "Worship", sortKey: "worshipDay", render: (d) => `${d.worshipDay} ${d.worshipTime}` },
    { key: "language", header: "Language", render: (d) => d.language },
    { key: "status", header: "Status", sortKey: "status", render: (d) => <StatusBadge status={d.status} /> },
    {
      key: "actions", header: "",
      render: (d) =>
        canWrite ? (
          <span className="actions-row" style={{ margin: 0 }}>
            <Link className="btn btn-secondary" href={`/dako/${d.id}/edit`}>Edit</Link>
            {d.status === "ACTIVE" ? (
              <ConfirmDialog
                triggerLabel="Disable"
                className="btn btn-danger"
                title="Disable dako"
                description={`Disable ${d.name} (${d.dakoCode})? It will no longer be selectable as a new Current Destination or scheduling target. Existing teacher destinations and all historical records remain untouched.`}
                confirmLabel="Disable"
                requireReason
                hiddenFields={{ id: d.id }}
                action={disableAction}
              />
            ) : (
              <ConfirmDialog
                triggerLabel="Enable"
                title="Enable dako"
                description={`Restore ${d.name} (${d.dakoCode}) to Active?`}
                confirmLabel="Enable"
                hiddenFields={{ id: d.id }}
                action={enableAction}
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
    worshipDay: query.worshipDay,
    sort: query.sort,
    order: query.order,
    pageSize: query.pageSize ? String(query.pageSize) : undefined,
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dako</h1>
          <p>Master data — current state. History is preserved in the audit trail.</p>
        </div>
        {canWrite ? <Link className="btn btn-primary" href="/dako/new">Add Dako</Link> : null}
      </div>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {/* Filters apply as they change (no Apply button); sort/order/pageSize are
          preserved so filtering never silently drops the active sort. */}
      <FilterForm
        action="/dako"
        fields={[
          { kind: "search", name: "q", placeholder: "Search code, name, or address…" },
          ...DAKO_FILTERS,
          { name: "worshipDay", label: "Worship Day", options: DAY_OPTIONS },
        ]}
        values={baseSearch}
        preserve={{
          sort: query.sort,
          order: query.order,
          pageSize: query.pageSize ? String(query.pageSize) : undefined,
        }}
      />

      <DataTable
        columns={columns}
        rows={rows}
        sort={query.sort}
        order={query.order}
        baseSearch={baseSearch}
        emptyMessage={query.q || query.status || query.language || query.isPriority || query.worshipDay ? "No dako match your filters." : "No dako yet. Add the first dako to get started."}
      />

      <Pagination page={page} pageCount={pageCount} total={total} baseSearch={baseSearch} basePath="/dako" />
    </>
  );
}
