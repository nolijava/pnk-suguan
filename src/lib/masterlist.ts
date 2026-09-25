/**
 * New Update #4 — Teacher Masterlist field catalogue (CLIENT-SAFE, pure data).
 *
 * The selectable fields of the masterlist report live here so the page's
 * field-selection modal and the server-side PDF builder read ONE catalogue:
 * the UI can never offer a field the PDF cannot render, and the PDF can never
 * print a field the user did not select. Every code maps to a real `teachers`
 * column (or a value derived from one); nothing is invented.
 *
 * Kept free of server imports on purpose — it is imported by a client
 * component, so it must not pull in PDFKit or the database client.
 */
export const MASTERLIST_FIELD_CODES = [
  "teacherCode",
  "name",
  "firstName",
  "middleName",
  "lastName",
  "suffix",
  "purokGrupo",
  "birthday",
  "age",
  "dateOfOath",
  "currentDestination",
  "duty",
  "language",
  "status",
  "dateInactive",
  "inactiveReason",
  "remarks",
] as const;

export type MasterlistFieldCode = (typeof MASTERLIST_FIELD_CODES)[number];

export interface MasterlistFieldMeta {
  /** Column header printed in the PDF / preview table. */
  label: string;
  /** Relative column width used by the PDF renderer. */
  weight: number;
  /** Explains where the value comes from (shown in the modal). */
  source: string;
  /** Pre-ticked in the modal — core identity, relationship and state. */
  defaultOn: boolean;
}

export const MASTERLIST_FIELDS: Record<MasterlistFieldCode, MasterlistFieldMeta> = {
  teacherCode: { label: "Teacher Code", weight: 1.1, source: "teachers.teacher_code", defaultOn: true },
  name: { label: "Name", weight: 2.6, source: "First + Middle + Last + Suffix", defaultOn: true },
  firstName: { label: "First Name", weight: 1.4, source: "teachers.first_name", defaultOn: false },
  middleName: { label: "Middle Name", weight: 1.3, source: "teachers.middle_name", defaultOn: false },
  lastName: { label: "Last Name", weight: 1.4, source: "teachers.last_name", defaultOn: false },
  suffix: { label: "Suffix", weight: 0.8, source: "teachers.suffix", defaultOn: false },
  purokGrupo: { label: "Purok/Grupo", weight: 1.3, source: "teachers.purok_grupo", defaultOn: true },
  birthday: { label: "Birthday", weight: 1.1, source: "teachers.birthday", defaultOn: true },
  age: { label: "Age", weight: 0.7, source: "Derived from Birthday (never stored)", defaultOn: true },
  dateOfOath: { label: "Panunumpa (Oath)", weight: 1.2, source: "teachers.date_of_oath", defaultOn: true },
  currentDestination: { label: "Current Destination", weight: 2, source: "dako (current destination)", defaultOn: true },
  duty: { label: "Duty", weight: 1, source: "Duty of the current destination period", defaultOn: true },
  language: { label: "Language", weight: 1, source: "teachers.language", defaultOn: false },
  status: { label: "Status", weight: 0.9, source: "teachers.status", defaultOn: true },
  dateInactive: { label: "Date Inactive", weight: 1.1, source: "teachers.date_inactive", defaultOn: false },
  inactiveReason: { label: "Inactive Reason", weight: 1.6, source: "teachers.inactive_reason", defaultOn: false },
  remarks: { label: "Remarks", weight: 2, source: "teachers.remarks", defaultOn: false },
};

/** The selection the modal opens with (and the PDF falls back to). */
export const MASTERLIST_DEFAULT_FIELDS: MasterlistFieldCode[] = MASTERLIST_FIELD_CODES.filter(
  (code) => MASTERLIST_FIELDS[code].defaultOn,
);

/** True only for a real field code (used by the modal before building a URL). */
export function isMasterlistField(value: unknown): value is MasterlistFieldCode {
  return typeof value === "string" && (MASTERLIST_FIELD_CODES as readonly string[]).includes(value);
}
