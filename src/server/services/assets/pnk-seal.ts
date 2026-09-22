/**
 * The Patotoo slip's seal — the reference form's own emblem, embedded verbatim.
 *
 * `Suguan Slip.pdf` (the physical reference for the appended Patotoo pages)
 * carries a 167 × 163px JPEG at the top-left of EACH copy, measured on the
 * reference at x 33.81–94.06 / fromTop 24.21–83.16 (60.25 × 58.95pt). The bytes
 * below are that image exactly as it sits in the reference's DCTDecode stream —
 * no re-encode, no resize, no crop, no recompression:
 *
 *   bytes  : 7539 (the stream's own declared /Length — the CRLF that separates
 *            the stream from `endstream` is NOT part of the image)
 *   sha256 : 2ceda4c4bbf9b3b71a62180603551148897e0a19353390f12956ff6b59ae1d9e
 *
 * WHY BASE64 RATHER THAN A FILE UNDER `public/`: the PDF layer is pure — it
 * renders a view model and touches no filesystem — and a file on disk would have
 * to be located relative to the process CWD, which differs between `next dev`
 * (repo root) and the packaged standalone payload (`app/public/…`, next to
 * `app/server.js`). Embedding keeps the renderer self-contained and adds no
 * packaging rule to `scripts/package-windows.mjs`.
 */
const PNK_SEAL_JPEG_BASE64_CHUNKS = [
  "/9j/4AAQSkZJRgABAQEAeAB4AAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a",
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy",
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCACjAKcDASIA",
  "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA",
  "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3",
  "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm",
  "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA",
  "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx",
  "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK",
  "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3",
  "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD36iii",
  "gAooooAKKq3moQWS/O2XPRB1NYNxqN3fv5aZCnoid/rXnYvMqOHfL8UuyN6WHnU12Xc3LjU7W3yD",
  "JvYfwpzWbNr0rcQxKo9W5NNt9DlYb7hxGvoOTV1YdNtGiG1WaRtqsfmyf5VxOeY4jVtU4/j/AF9x",
  "slQhoveZlfbdQuT8ryt/1zX/AApfsmoy9UmP+82P5mtq41GG0vIbd+BIM7uy+n9anupGitJpExuV",
  "Cwz9KSyuM+b2laUmt/61H9YcbcsErnPf2ZqHXym/77H+NJ9m1KLosw/3WJ/lVuHW5Li5tkUbAQ3m",
  "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",
  "CiiigAooooAKKKKAP//Z",
];

/** The reference's own pixel dimensions — asserted by test against the decode. */
export const PNK_SEAL_PIXELS = { width: 167, height: 163 } as const;

/** Byte length of the embedded JPEG — asserted by test. */
export const PNK_SEAL_BYTES = 7539;

let cached: Buffer | null = null;

/**
 * The seal as a JPEG buffer, decoded once. PDFKit embeds a JPEG buffer
 * directly (no re-encode), which is what keeps the printed seal identical to
 * the reference's.
 */
export function pnkSealJpeg(): Buffer {
  if (cached === null) cached = Buffer.from(PNK_SEAL_JPEG_BASE64_CHUNKS.join(""), "base64");
  return cached;
}
