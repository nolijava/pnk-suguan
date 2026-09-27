import { isoWeeksInYear } from "./iso-week";

export const MAGTUTURO_HISTORY_SEATS = [
  { magType: "SUGO", seat: 1, label: "SUGO 1" },
  { magType: "SUGO", seat: 2, label: "SUGO 2" },
  { magType: "SUGO", seat: 3, label: "SUGO 3" },
  { magType: "SUGO", seat: 4, label: "SUGO 4" },
  { magType: "RESERBA", seat: 1, label: "RESERBA 1" },
  { magType: "RESERBA", seat: 2, label: "RESERBA 2" },
] as const;

export interface MagtuturoHistoryInput {
  year: number;
  isoWeekNumber: number;
  magType: "SUGO" | "RESERBA";
  seat: number;
  teacherName: string;
}

export interface MagtuturoHistoryGrid {
  year: number;
  weekNumbers: number[];
  rows: {
    label: string;
    magType: "SUGO" | "RESERBA";
    seat: number;
    cells: (string | null)[];
  }[];
}

/** Build the annual display strictly from persisted Magtuturo assignment rows. */
export function buildMagtuturoHistory(rows: MagtuturoHistoryInput[], year: number): MagtuturoHistoryGrid {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new Error("Invalid Magtuturo ISO year");
  }
  const weekCount = isoWeeksInYear(year);
  const weekNumbers = Array.from({ length: weekCount }, (_, i) => i + 1);
  const assignments = new Map<string, string>();
  for (const row of rows) {
    if (row.year !== year || row.isoWeekNumber < 1 || row.isoWeekNumber > weekCount) continue;
    if (!MAGTUTURO_HISTORY_SEATS.some((seat) => seat.magType === row.magType && seat.seat === row.seat)) continue;
    assignments.set(`${row.magType}|${row.seat}|${row.isoWeekNumber}`, row.teacherName);
  }
  return {
    year,
    weekNumbers,
    rows: MAGTUTURO_HISTORY_SEATS.map((seat) => ({
      ...seat,
      cells: weekNumbers.map((week) => assignments.get(`${seat.magType}|${seat.seat}|${week}`) ?? null),
    })),
  };
}
