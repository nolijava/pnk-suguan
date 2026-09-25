import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { FilterForm } from "@/app/(admin)/_components";
import { teacherMasterlistRows, masterlistValue } from "@/server/services/report-pdf.service";
import { MASTERLIST_DEFAULT_FIELDS, MASTERLIST_FIELDS } from "@/lib/masterlist";
import { ReportPdfButton } from "../pdf-button";
import { MasterlistPdfModal } from "./masterlist-pdf-client";

export const dynamic = "force-dynamic";

/**
 * New Update #4 — Teacher Masterlist.
 *
 * A read-only master-data listing with a field-selection step before export:
 * the preview below shows the CORE columns, while the modal lets the operator
 * tick exactly which Teacher information the PDF should contain. Both read the
 * one field catalogue in `@/lib/masterlist` (real schema fields only), and the
 * PDF route re-validates the selection server-side.
 */
export default async function TeacherMasterlistPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => (Array.isArray(v) ? [k, v[0]] : [k, v])));

  const status = flat.status === "ACTIVE" || flat.status === "INACTIVE" ? flat.status : undefined;
  const language = flat.language === "FILIPINO" || flat.language === "ENGLISH" ? flat.language : undefined;
  const duty = flat.duty === "DESTINADO" || flat.duty === "KATUWANG" ? flat.duty : undefined;

  const rows = await teacherMasterlistRows({ status, language, duty });
  const previewColumns = MASTERLIST_DEFAULT_FIELDS;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Teacher Masterlist</h1>
          <p>
            Master data as stored — {rows.length} teacher(s). Choose the fields to export and generate a PDF;
            nothing is computed except Age (from Birthday).
          </p>
        </div>
        <span className="actions-row">
          <Link className="btn btn-secondary" href="/reports">Back to Reports</Link>
        </span>
      </div>

      <FilterForm
        action="/reports/teacher-masterlist"
        values={{ status, language, duty }}
        resetHref="/reports/teacher-masterlist"
        resetLabel="All teachers"
        fields={[
          {
            name: "status",
            label: "Status",
            options: [
              { value: "ACTIVE", label: "Active" },
              { value: "INACTIVE", label: "Inactive" },
            ],
          },
          {
            name: "language",
            label: "Language",
            options: [
              { value: "FILIPINO", label: "Filipino" },
              { value: "ENGLISH", label: "English" },
            ],
          },
          {
            name: "duty",
            label: "Duty",
            options: [
              { value: "DESTINADO", label: "Destinado" },
              { value: "KATUWANG", label: "Katuwang" },
            ],
          },
        ]}
      />

      <div className="actions-row">
        <MasterlistPdfModal filters={{ status, language, duty }} total={rows.length} />
        {/* One-click default export (core columns) — the modal is for custom sets. */}
        <ReportPdfButton
          report="teacher-masterlist"
          params={{ status, language, duty }}
          label="Generate PDF (core fields)"
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {previewColumns.map((c) => (
                <th key={c} scope="col">{MASTERLIST_FIELDS[c].label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={previewColumns.length}>No teachers match the selected filters.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.teacherCode}>
                  {previewColumns.map((c) => (
                    <td key={c}>{masterlistValue(row, c)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="info-note">
        Preview shows the core columns. The PDF can contain any selection of the available Teacher fields — Teacher
        Code, name parts, Purok/Grupo, Birthday, Age, Panunumpa (Oath) date, Current Destination, Duty, Language,
        Status, Date Inactive, Inactive Reason and Remarks. Only the selected fields are printed.
      </p>
    </>
  );
}
