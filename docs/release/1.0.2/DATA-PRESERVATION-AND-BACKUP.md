# PNK Suguan 1.0.2 — Data Preservation and Manual Backup Guidance

Program files and user data are separate:

```text
Program: %LOCALAPPDATA%\\Programs\\PNK Suguan\\
Data:    %LOCALAPPDATA%\\PNK Suguan\\
```

Normal uninstall removes the program payload but preserves the data directory. Reinstall and upgrade are designed to reuse it. Do not delete the data folder when troubleshooting an installation or upgrade.

PNK Suguan does not provide an automated Backup/Restore feature or scheduled backup service. If an operator requires protection, establish a documented manual backup procedure for the user-data directory while the application is stopped, protect the copy, and verify restoration separately. Never distribute the data directory with the installer.
