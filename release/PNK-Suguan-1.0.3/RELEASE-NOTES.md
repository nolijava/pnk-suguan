# PNK Suguan 1.0.3 — Release Notes

## Release

- Product: **PNK Suguan**
- Version (installer/package): **1.0.3**
- Application version: **0.1.2**
- Publisher: **RetsLi**
- Build ID: **20260922140500-7c3a9d**
- Bundled Node.js: **v22.23.2**
- Bundled PostgreSQL: **16.14**
- Release status: **READY FOR RELEASE**

## Major change — graceful application shutdown fix

This release fixes the Windows graceful application shutdown defect discovered during v1.0.2 release QA. In v1.0.2 a normal shutdown could report that the application "did not exit in time" and the launcher had to forcibly terminate the application process before stopping PostgreSQL.

Background (high level):

- The previous launcher behavior relied on terminating a detached application process. Windows cannot reliably deliver a close event to a detached console process, so the application had no opportunity to shut itself down, and normal shutdown reached the launcher's forced-termination fallback.
- The application now has an **application-owned local shutdown channel**. When the launcher starts the application, it passes a same-user Windows named pipe dedicated to shutdown control.
- On normal shutdown, the launcher sends a **shutdown request through the Windows named pipe** instead of trying to terminate the process.
- The application closes its control listener and its HTTP server / active connections.
- The application **exits gracefully** from inside its own process.
- The launcher **no longer reaches the forced-termination timeout** during normal shutdown; PostgreSQL and the launcher then stop cleanly as before.

Startup, application functionality, and data handling are unaffected by this change.

## Publisher metadata

- Company / Publisher: **RetsLi**
- Product: **PNK Suguan**
- Installer version: **1.0.3**

The RetsLi publisher metadata is **installer/Windows version-resource metadata only**. It does **not** imply that the executable has a code-signing certificate; this release is not code-signed.

## Preserved functionality

The following existing functionality remains intact and unchanged in this release:

- Dako management
- Teacher/Guro management
- Teacher availability
- Weekly scheduling
- SUGO
- RESERBA
- RESERBA II
- DRAFT / FINALIZED / PUBLISHED lifecycle
- Language compatibility enforcement
- Current Destination
- Destination History
- Audit logging
- Authentication
- RBAC
- Viewer restrictions
- Weekly Suguan PDF
- Patotoo ORIGINAL/DUPLICATE slips
- PostgreSQL-backed persistent data

## Validation

Final release QA was executed against the exact approved v1.0.3 installer (`PNK-Suguan-Setup-1.0.3.exe`, SHA-256 `d93932165a9eff73c713b1996465f344bb00499bf04fc77cbfec12efae5dc1b5`):

- Full test suite: **506 passed, 1 skipped**
- Typecheck: **PASS**
- Production build: **PASS**
- Packaging audit: **PASS**
- Clean-machine fresh installation: **PASS**
- First-run authentication: **PASS**
- v1.0.2 → v1.0.3 upgrade: **PASS**
- Uninstall → reinstall preservation: **PASS**
- Database preservation: **PASS**
- ADMIN/VIEWER RBAC: **PASS**
- W39 PUBLISHED: **PASS**
- W01 DRAFT: **PASS**
- 66 assignments preserved: **PASS**
- W39/W01 PDF endpoints: **PASS**
- Graceful shutdown: **PASS**
- Restart: **PASS**

## Known release note

The graceful shutdown issue found in v1.0.2 is **fixed in v1.0.3**. v1.0.2 is retained as a protected historical artifact and is **not** a recommended installation; new installations and upgrades should use v1.0.3.

## Artifact checksums

```
d93932165a9eff73c713b1996465f344bb00499bf04fc77cbfec12efae5dc1b5  PNK-Suguan-Setup-1.0.3.exe
b2cf179790588d7e1fc1ca256b6b5f38322ac5559bcc4a127e3db463adc31ae8  PNK-Suguan-1.0.3.zip
```
