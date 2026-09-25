/**
 * Guro Duty display helper (New Update #6/#7/#8).
 *
 * ONE place maps the two sanctioned duty codes to their human labels, so the
 * teacher page, the dako page and the masterlist/report PDFs can never drift
 * apart. Presentation only: nothing here validates or invents a value — an
 * absent or unknown duty renders as an em dash, never as a guessed label.
 */
export const DUTY_VALUES = ["DESTINADO", "KATUWANG"] as const;
export type DutyCode = (typeof DUTY_VALUES)[number];

const LABELS: Record<string, string> = {
  DESTINADO: "Destinado",
  KATUWANG: "Katuwang",
};

/** True only for the two sanctioned codes (mirrors the service-side check). */
export function isDutyCode(value: unknown): value is DutyCode {
  return typeof value === "string" && (DUTY_VALUES as readonly string[]).includes(value);
}

/** Human label for a duty code; "—" when none/unknown (never invented). */
export function dutyLabel(value: string | null | undefined): string {
  return value && LABELS[value] ? LABELS[value] : "—";
}
