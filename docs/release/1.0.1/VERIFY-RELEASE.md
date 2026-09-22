# Verifying the PNK Suguan 1.0.1 installer

Before you run anything, confirm that the installer file you received is **bit-for-bit** the validated
release. This takes about ten seconds and protects you from a corrupted download or a tampered file.

**Expected SHA-256 of `PNK-Suguan-Setup-1.0.1.exe`:**

```
b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093
```

The hash must match **exactly**. If it does not match, **do not install the file** — obtain it again from
your distribution source and re-verify.

---

## Method 1 — `certutil` (available on every supported Windows version)

1. Open **Command Prompt** (press `Win`, type `cmd`, press Enter).
2. Change to the folder holding the installer, for example:

   ```
   cd "%USERPROFILE%\Downloads\PNK-Suguan-1.0.1"
   ```

3. Run:

   ```
   certutil -hashfile "PNK-Suguan-Setup-1.0.1.exe" SHA256
   ```

4. `certutil` prints the hash on the second line. Compare it with the expected value above.

   Note: `certutil` sometimes prints the hash with spaces between byte pairs depending on the Windows
   version. Spaces are not significant — `b2097e0f 67885427 ...` is the same hash as
   `b2097e0f67885427...`. Letter case is also not significant.

## Method 2 — PowerShell

1. Open **PowerShell**.
2. Run, adjusting the path to where your copy of the installer is:

   ```
   Get-FileHash -Algorithm SHA256 ".\PNK-Suguan-Setup-1.0.1.exe"
   ```

   Or compare it in one step and get a clear verdict:

   ```
   $expected = "b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093"
   $actual   = (Get-FileHash -Algorithm SHA256 ".\PNK-Suguan-Setup-1.0.1.exe").Hash
   if ($actual -eq $expected) { "OK - hash matches" } else { "MISMATCH - do not install" }
   ```

   (Type those lines on one line each, or paste them together — the middle line joins the two.)

## Method 3 — `sha256sum` (Git for Windows / MSYS / WSL, if you already have it)

```
sha256sum PNK-Suguan-Setup-1.0.1.exe
```

The bundled `.sha256` file uses exactly this format, so this also works:

```
sha256sum -c PNK-Suguan-Setup-1.0.1.sha256
```

---

## Verifying the whole package

`MANIFEST.sha256` lists the SHA-256 of every file in this package in the standard format. With Git for
Windows / MSYS / WSL present, run this **inside the package folder**:

```
sha256sum -c MANIFEST.sha256
```

Every line should report `OK`. Any `FAILED` line means that file does not match the manifest.

**Two things to know about this manifest:**

1. The manifest **does not list itself** — a checksum file cannot contain its own hash. That is expected,
   not a missing entry.
2. It is a **single-stage** manifest. It proves that this package's files are mutually consistent with the
   list you received; it does not, by itself, prove the list came from a trusted publisher. Confirm the
   installer's own hash against the value published above, and obtain the package through your
   organisation's distribution channel.

The manifest is written with forward slashes and sorted paths, so it verifies identically on Windows,
Linux and macOS tooling.

---

## If the hash does not match

1. **Do not run the installer.**
2. Delete the file and obtain a fresh copy from your distribution source.
3. Verify again.
4. If a fresh copy still fails, **stop and report it** to «internal IT contact» (placeholder — replace with
   your organisation's support channel). Do not attempt to repair, re-pack, or "fix" the file, and do not
   install it with a bypass.

A mismatch is not a software problem you can work around. It means the file is not the validated release.

---

## What verification does and does not prove

**Proves:** the file you hold is byte-identical to the validated release candidate, and the package's
files match the published manifest.

**Does not prove:** who built it, or that it is free of malware — this release carries **no code signature**.
That is a documented limitation of 1.0.1 (see `RELEASE-NOTES.md`, section "Known limitations"). Hash
verification against a trusted, separately-obtained expected value is the trust anchor for this release;
Windows SmartScreen may still warn on first run, and `TROUBLESHOOTING.md` explains that warning.
