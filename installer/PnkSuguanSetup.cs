/*
 * PNK Suguan System - Windows installer / uninstaller (L6).
 *
 * Compiled with the in-box .NET Framework C# compiler (csc.exe, C# 5) - no SDK,
 * no NuGet, no download. This is a DEPLOYMENT layer only: it copies the validated
 * program payload and registers it with Windows. It deliberately does NOT own
 * PostgreSQL, migrations, first-run setup, secret generation, port selection,
 * health checks, browser launch or shutdown - the launcher owns all of that.
 *
 * Layout invariant:
 *   PROGRAM  %LOCALAPPDATA%\Programs\PNK Suguan   (this installer, replaceable)
 *   DATA     %LOCALAPPDATA%\PNK Suguan            (launcher-owned, NEVER touched)
 *
 * Uninstall removes the program payload, the shortcuts and the registry entry,
 * and preserves the data directory so a reinstall picks the existing database up
 * unchanged.
 *
 * Usage:
 *   PNK-Suguan-Setup.exe [ /dir=<path> ] [ /quiet ] [ /launch | /nolaunch ]
 *   "Uninstall PNK Suguan.exe" /uninstall [ /quiet ]
 */

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

[assembly: AssemblyTitle("PNK Suguan System Setup")]
[assembly: AssemblyProduct("PNK Suguan")]
[assembly: AssemblyCompany("RetsLi")]
[assembly: AssemblyVersion("2.1.0.0")]
[assembly: AssemblyFileVersion("2.1.0.0")]
[assembly: AssemblyInformationalVersion("2.1.0")]
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.0")]

namespace PnkSuguanSetup
{
    internal static class Program
    {
        private const string APP_NAME = "PNK Suguan";
        private const string APP_VERSION = "2.1.0";
        private const string UNINSTALL_SUBKEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PNK Suguan";
        private const string PAYLOAD_RESOURCE = "payload.zip";
        private const string PAYLOAD_SIBLING = "payload.zip";
        private const string LAUNCHER_ENTRY = "Start PNK Suguan.cmd";
        private const string UNINSTALLER_EXE = "Uninstall PNK Suguan.exe";
        /// <summary>Shipped multi-resolution brand icon, inside the program payload.</summary>
        private const string BRAND_ICON = "pnk-suguan.ico";

        private static int Main(string[] args)
        {
            try
            {
                if (Has(args, "/uninstall") || Has(args, "/u")) return Uninstall(args);
                return Install(args);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine("  ! " + ex.Message);
                Console.Error.WriteLine();
                return 1;
            }
        }

        // ----------------------------------------------------------------- install
        private static int Install(string[] args)
        {
            string installDir = Normalize(GetArg(args, "/dir="));
            if (installDir == null || installDir.Length == 0) installDir = DefaultInstallDir();
            bool quiet = Has(args, "/quiet");
            bool launch = !Has(args, "/nolaunch") && (Has(args, "/launch") || !quiet);

            string dataDir = UserDataDir();
            if (IsInside(installDir, dataDir))
                throw new InvalidOperationException("Refusing to install INSIDE the user data directory (" + dataDir + "). Program files and data must stay separate.");

            Banner();
            Console.WriteLine("  install   " + installDir);

            if (!quiet) Console.WriteLine("  data      " + dataDir + "  (preserved on uninstall)");
            Console.WriteLine();

            // Payload must not land on top of an existing *data* tree by accident.
            if (Directory.Exists(installDir) && File.Exists(Path.Combine(installDir, "pgdata")))
                throw new InvalidOperationException("The target directory looks like a PostgreSQL data directory. Refusing to overwrite it.");

            // Refuse to overwrite a payload that is still in use. Without this the
            // extraction dies part-way through on the first locked file and leaves
            // the installation as a MIX of two versions - working, but wrong.
            AssertPayloadNotInUse(installDir);

            Console.WriteLine("  -> extracting program payload");
            int files = ExtractPayload(installDir);
            Console.WriteLine("     " + files.ToString(CultureInfo.InvariantCulture) + " files");

            Console.WriteLine("  -> creating shortcuts");
            CreateShortcuts(installDir);

            Console.WriteLine("  -> registering in Apps & Programs");
            WriteInstallInfo(installDir, dataDir);
            WriteUninstallEntry(installDir);

            Console.WriteLine("  -> installing the uninstaller");
            string self = Assembly.GetExecutingAssembly().Location;
            string uninstallerPath = Path.Combine(installDir, UNINSTALLER_EXE);
            if (!PathsEqual(self, uninstallerPath)) File.Copy(self, uninstallerPath, true);

            Console.WriteLine();
            Console.WriteLine("  " + APP_NAME + " " + APP_VERSION + " installed.");
            Console.WriteLine();
            Console.WriteLine("  Program : " + installDir);
            Console.WriteLine("  Data    : " + dataDir);
            Console.WriteLine("  Start   : Start Menu > " + APP_NAME);
            Console.WriteLine();

            if (launch)
            {
                string entry = Path.Combine(installDir, LAUNCHER_ENTRY);
                if (File.Exists(entry))
                {
                    Console.WriteLine("  -> starting " + APP_NAME + " (first run initialises the database)");
                    Console.WriteLine();
                    ProcessStartInfo psi = new ProcessStartInfo(entry);
                    psi.WorkingDirectory = installDir;
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                else
                {
                    Console.WriteLine("  ! launcher entry point not found: " + LAUNCHER_ENTRY);
                }
            }

            return 0;
        }

        // --------------------------------------------------------------- uninstall
        private static int Uninstall(string[] args)
        {
            bool quiet = Has(args, "/quiet");
            string installDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string dataDir = UserDataDir();

            Banner();
            Console.WriteLine("  remove    " + installDir);
            Console.WriteLine("  keep      " + dataDir);
            Console.WriteLine();

            Console.WriteLine("  -> removing shortcuts");
            RemoveShortcuts();

            Console.WriteLine("  -> removing the Apps & Programs entry");
            try { Registry.CurrentUser.DeleteSubKeyTree(UNINSTALL_SUBKEY, false); }
            catch (Exception ex) { Warn("could not remove the uninstall entry: " + ex.Message); }

            Console.WriteLine("  -> removing program files");
            // User data must survive even if someone points this at the wrong tree.
            if (IsInside(dataDir, installDir) || PathsEqual(installDir, dataDir))
                throw new InvalidOperationException("Refusing to remove the user data directory (" + dataDir + ").");

            string self = Assembly.GetExecutingAssembly().Location;
            int removed = 0;
            bool failed = false;
            foreach (string file in Directory.GetFiles(installDir, "*", SearchOption.AllDirectories))
            {
                if (PathsEqual(file, self)) continue;
                try { File.Delete(file); removed++; }
                catch { failed = true; }
            }
            foreach (string dir in Directory.GetDirectories(installDir, "*", SearchOption.AllDirectories))
            {
                try { if (Directory.GetFileSystemEntries(dir).Length == 0) Directory.Delete(dir); }
                catch { failed = true; }
            }

            Console.WriteLine();
            Console.WriteLine("  " + APP_NAME + " uninstalled. Removed " + removed.ToString(CultureInfo.InvariantCulture) + " file(s).");
            Console.WriteLine();
            Console.WriteLine("  YOUR DATA HAS BEEN KEPT:");
            Console.WriteLine("    " + dataDir);
            Console.WriteLine("  Reinstalling will reuse this database, configuration and history.");
            Console.WriteLine("  To remove it as well, delete that folder manually.");
            Console.WriteLine();
            if (!quiet) Console.WriteLine("  This window can be closed.");

            // The running executable cannot delete itself (or its own directory), so
            // hand the last step to a detached shell that waits for us to exit.
            ScheduleSelfCleanup(installDir, self, failed);
            return 0;
        }

        private static void ScheduleSelfCleanup(string installDir, string self, bool partial)
        {
            string cmd = string.Format(
                CultureInfo.InvariantCulture,
                "/c ping -n 3 127.0.0.1 >nul & del /f /q \"{0}\" & rmdir /s /q \"{1}\"",
                self, installDir);
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmd);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            try { Process.Start(psi); }
            catch (Exception ex) { Warn("could not schedule removal of " + installDir + ": " + ex.Message); }
            if (partial) Warn("some files could not be removed; they may be locked. Remove the folder manually.");
        }

        // ----------------------------------------------------------------- payload
        private static int ExtractPayload(string installDir)
        {
            Stream source = null;
            Assembly asm = Assembly.GetExecutingAssembly();
            string[] names = asm.GetManifestResourceNames();
            for (int i = 0; i < names.Length; i++)
            {
                if (names[i].EndsWith(PAYLOAD_RESOURCE, StringComparison.OrdinalIgnoreCase))
                {
                    source = asm.GetManifestResourceStream(names[i]);
                    break;
                }
            }
            if (source == null)
            {
                string sibling = Path.Combine(Path.GetDirectoryName(asm.Location), PAYLOAD_SIBLING);
                if (File.Exists(sibling)) source = File.OpenRead(sibling);
            }
            if (source == null)
                throw new FileNotFoundException("The program payload is missing. Expected an embedded '" + PAYLOAD_RESOURCE + "' resource or a '" + PAYLOAD_SIBLING + "' file next to the installer.");

            int count = 0;
            string root = Path.GetFullPath(installDir);
            using (source)
            using (ZipArchive zip = new ZipArchive(source, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                    while (name.StartsWith(".\\", StringComparison.Ordinal)) name = name.Substring(2);
                    if (name.Length == 0) continue;
                    if (name.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)) continue;

                    string target = Path.GetFullPath(Path.Combine(root, name));
                    if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Payload entry escapes the install directory: " + name);

                    string parent = Path.GetDirectoryName(target);
                    if (parent != null && parent.Length > 0 && !Directory.Exists(parent)) Directory.CreateDirectory(parent);

                    if (IsDirectoryEntry(entry)) { Directory.CreateDirectory(target); continue; }

                    entry.ExtractToFile(target, true);
                    count++;
                }
            }
            return count;
        }

        /// <summary>
        /// Preflight: the files an upgrade must overwrite are exactly the ones a
        /// running instance keeps open. Probing them for exclusive access detects
        /// "PNK Suguan is running" precisely, with no pid heuristics and no false
        /// positives, and reports it before anything is written.
        /// </summary>
        private static void AssertPayloadNotInUse(string installDir)
        {
            string[] probes = new string[]
            {
                Path.Combine(installDir, "node", "node.exe"),
                Path.Combine(installDir, "postgres", "bin", "postgres.exe"),
                Path.Combine(installDir, "postgres", "bin", "pg_ctl.exe"),
                Path.Combine(installDir, "postgres", "lib", "plpgsql.dll"),
                Path.Combine(installDir, "app", "server.js"),
                Path.Combine(installDir, "launcher", "launcher.mjs"),
            };
            foreach (string probe in probes)
            {
                if (!File.Exists(probe)) continue;
                try
                {
                    using (FileStream fs = File.Open(probe, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                }
                catch (IOException)
                {
                    throw new InvalidOperationException(
                        APP_NAME + " is currently running, so its files cannot be replaced.\n" +
                        "  Close it first (Start Menu > " + APP_NAME + " > Stop, or the Stop button in its window),\n" +
                        "  then run this installer again.\n" +
                        "  Your database and settings are not affected by this, or by upgrading.");
                }
                catch (UnauthorizedAccessException)
                {
                    throw new InvalidOperationException(
                        "No permission to replace files in " + installDir + ".\n" +
                        "  Run the installer again with sufficient rights for that location.");
                }
            }
        }

        private static bool IsDirectoryEntry(ZipArchiveEntry entry)
        {
            // Directory entries carry no length and an empty name after the last slash.
            return entry.Length == 0 && (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal));
        }

        // --------------------------------------------------------------- shortcuts
        private static void CreateShortcuts(string installDir)
        {
            string entry = Path.Combine(installDir, LAUNCHER_ENTRY);
            string work = installDir;

            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP_NAME + ".lnk");
            string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP_NAME + ".lnk");

            TryShortcut(startMenu, entry, work, "Start Menu");
            TryShortcut(desktop, entry, work, "Desktop");
        }

        private static void TryShortcut(string linkPath, string target, string workDir, string what)
        {
            try
            {
                string parent = Path.GetDirectoryName(linkPath);
                if (parent != null && !Directory.Exists(parent)) Directory.CreateDirectory(parent);
                // The entry point is a .cmd, which carries no icon resource of its
                // own — without an explicit IconLocation Windows would show the
                // generic batch-file icon. Point at the shipped brand icon, and
                // fall back to the target's own icon only if it is missing.
                string icon = BrandIconPath(workDir);
                ComShortcut.Create(linkPath, target, null, workDir, icon != null ? icon + ",0" : target + ",0");
                Console.WriteLine("     " + what + ": " + Path.GetFileName(linkPath));
            }
            catch (Exception ex)
            {
                Warn("could not create the " + what + " shortcut: " + ex.Message);
            }
        }

        /// <summary>
        /// Path to the shipped brand icon (public/logo/pnk-suguan.ico in the
        /// repository, app/public/logo/ inside the payload), or null when it is
        /// absent so callers can fall back to the target's own icon.
        /// </summary>
        private static string BrandIconPath(string installDir)
        {
            string icon = Path.Combine(installDir, Path.Combine(Path.Combine("app", "public"), Path.Combine("logo", BRAND_ICON)));
            return File.Exists(icon) ? icon : null;
        }

        private static void RemoveShortcuts()
        {
            string[] paths = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP_NAME + ".lnk"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP_NAME + ".lnk")
            };
            foreach (string p in paths)
            {
                try { if (File.Exists(p)) { File.Delete(p); Console.WriteLine("     removed " + Path.GetFileName(p)); } }
                catch (Exception ex) { Warn("could not remove " + p + ": " + ex.Message); }
            }
        }

        // -------------------------------------------------------------- registry
        private static void WriteInstallInfo(string installDir, string dataDir)
        {
            string manifest = Path.Combine(installDir, "BUILD-MANIFEST.json");
            string buildId = "";
            string payloadAppVersion = "";
            if (File.Exists(manifest))
            {
                string text = File.ReadAllText(manifest);
                buildId = JsonString(text, "buildId");
                payloadAppVersion = JsonString(text, "appVersion");
            }
            string info =
                "{\n" +
                "  \"product\": \"" + APP_NAME + "\",\n" +
                "  \"installerVersion\": \"" + APP_VERSION + "\",\n" +
                "  \"payloadAppVersion\": \"" + Escape(payloadAppVersion) + "\",\n" +
                "  \"payloadBuildId\": \"" + Escape(buildId) + "\",\n" +
                "  \"installedAt\": \"" + DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture) + "\",\n" +
                "  \"installDir\": \"" + Escape(installDir) + "\",\n" +
                "  \"userDataDir\": \"" + Escape(dataDir) + "\"\n" +
                "}\n";
            File.WriteAllText(Path.Combine(installDir, "INSTALL-INFO.json"), info, new UTF8Encoding(false));
        }

        private static string JsonString(string json, string key)
        {
            string needle = "\"" + key + "\"";
            int i = json.IndexOf(needle, StringComparison.Ordinal);
            if (i < 0) return "";
            i = json.IndexOf(':', i + needle.Length);
            if (i < 0) return "";
            i = json.IndexOf('"', i);
            if (i < 0) return "";
            int j = json.IndexOf('"', i + 1);
            if (j < 0) return "";
            return json.Substring(i + 1, j - i - 1);
        }

        private static string Escape(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void WriteUninstallEntry(string installDir)
        {
            string uninstaller = Path.Combine(installDir, UNINSTALLER_EXE);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UNINSTALL_SUBKEY))
            {
                if (key == null) throw new InvalidOperationException("Could not create the uninstall registry key.");
                key.SetValue("DisplayName", APP_NAME, RegistryValueKind.String);
                key.SetValue("DisplayVersion", APP_VERSION, RegistryValueKind.String);
                key.SetValue("Publisher", "RetsLi", RegistryValueKind.String);
                key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
                key.SetValue("DisplayIcon", uninstaller + ",0", RegistryValueKind.String);
                key.SetValue("UninstallString", "\"" + uninstaller + "\" /uninstall", RegistryValueKind.String);
                key.SetValue("QuietUninstallString", "\"" + uninstaller + "\" /uninstall /quiet", RegistryValueKind.String);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture), RegistryValueKind.String);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", DirectorySizeKb(installDir), RegistryValueKind.DWord);
            }
        }

        private static int DirectorySizeKb(string dir)
        {
            long total = 0;
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(f).Length; } catch { }
                }
            }
            catch { }
            long kb = total / 1024L;
            return kb > int.MaxValue ? int.MaxValue : (int)kb;
        }

        // ------------------------------------------------------------------ paths
        private static string DefaultInstallDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Path.Combine("Programs", APP_NAME));
        }

        private static string UserDataDir()
        {
            string overridden = Environment.GetEnvironmentVariable("PNK_DATA_DIR");
            if (overridden != null && overridden.Length > 0) return Normalize(overridden);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), APP_NAME);
        }

        private static bool IsInside(string candidate, string parent)
        {
            if (candidate == null || parent == null) return false;
            string c = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string p = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return c.StartsWith(p, StringComparison.OrdinalIgnoreCase);
        }

        private static bool PathsEqual(string a, string b)
        {
            if (a == null || b == null) return false;
            return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
        }

        private static string Normalize(string p)
        {
            if (p == null || p.Length == 0) return p;
            return p.Trim().Trim('"');
        }

        // ------------------------------------------------------------------- misc
        private static void Banner()
        {
            Console.WriteLine();
            Console.WriteLine("  " + APP_NAME + " System - Windows installer  v" + APP_VERSION);
            Console.WriteLine();
        }

        private static void Warn(string message)
        {
            Console.Error.WriteLine("  ! " + message);
        }

        private static bool Has(string[] args, string flag)
        {
            foreach (string a in args) if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static string GetArg(string[] args, string prefix)
        {
            foreach (string a in args)
                if (a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return a.Substring(prefix.Length);
            return null;
        }
    }

    /// <summary>
    /// WScript.Shell shortcut creation through late-bound COM, so the installer
    /// needs no interop assembly and no reference beyond the in-box framework.
    /// </summary>
    internal static class ComShortcut
    {
        public static void Create(string linkPath, string target, string arguments, string workingDirectory, string icon)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("WScript.Shell is unavailable on this system.");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = null;
            try
            {
                shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                if (arguments != null) shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
                if (workingDirectory != null) shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
                if (icon != null) shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { icon });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null) Marshal.ReleaseComObject(shortcut);
                if (shell != null) Marshal.ReleaseComObject(shell);
            }
        }
    }
}
