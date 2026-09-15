export type Language = "FILIPINO" | "ENGLISH";

/**
 * §22 Language eligibility:
 *  - English teacher: may serve English and Filipino dako.
 *  - Filipino teacher: may serve Filipino dako only.
 * Single source of truth — used by both the manual assignment flow and
 * (later) the scheduling engine.
 */
export function isTeacherEligibleForDako(
  teacherLanguage: Language,
  dakoLanguage: Language,
): boolean {
  if (dakoLanguage === "FILIPINO") return true;
  return teacherLanguage === "ENGLISH";
}
