# PNK Suguan 1.0.2 — Release Notes

- Installer/package version: **1.0.2**
- Application version: **0.1.1**
- Build ID: recorded in the release manifest
- Bundled Node.js: v22.23.2
- Bundled PostgreSQL: 16.14

## Included capability

This release packages the accepted Patotoo PDF implementation. Weekly Suguan PDF generation preserves the existing Page 1 and appends one 612 × 936 point page per populated assignment row, with ORIGINAL and DUPLICATE forms. The approved single-line fitting, Week-Year, PETSA, watermark, geometry, and read-only behavior are unchanged.

## Security and operation

The application is loopback-only, uses the existing authentication/session and server-side RBAC behavior, keeps PostgreSQL and application data under `%LOCALAPPDATA%\\PNK Suguan\\`, and does not package credentials or runtime data.

## Limitations

Per-user installation, HKCU registration, no code signing, no automatic updater, no separate physical PC/VM validation, structural/socket-level offline validation, the existing correction-security test-order coupling, one API-gated skipped test when not configured, and stale Next.js static assets after in-place upgrade remain documented limitations. No automated backup/restore feature is provided.
