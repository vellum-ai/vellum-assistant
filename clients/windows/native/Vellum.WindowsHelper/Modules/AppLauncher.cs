using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Vellum.WindowsHelper.Modules;

// Resolves a human app name the way the macOS helper does: activate a running
// app first, then launch via Start Menu shortcuts, then shell execution.
public static partial class AppLauncher
{
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["chrome"] = "Google Chrome", ["vs code"] = "Visual Studio Code", ["vscode"] = "Visual Studio Code",
        ["edge"] = "Microsoft Edge", ["word"] = "Word", ["excel"] = "Excel", ["powerpoint"] = "PowerPoint",
        ["outlook"] = "Outlook", ["explorer"] = "File Explorer", ["file explorer"] = "File Explorer",
        ["terminal"] = "Windows Terminal", ["cmd"] = "Command Prompt", ["notepad"] = "Notepad",
    };

    // Names that resolve straight to a shell command instead of a shortcut.
    private static readonly Dictionary<string, string> ShellCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        ["File Explorer"] = "explorer.exe", ["Command Prompt"] = "cmd.exe", ["Notepad"] = "notepad.exe",
        ["Calculator"] = "calc.exe", ["Settings"] = "ms-settings:", ["Windows Terminal"] = "wt.exe",
    };

    public static string Resolve(string name) => Aliases.TryGetValue(name.Trim(), out var alias) ? alias : name.Trim();

    public sealed record AppEntry(string Name, string Target);

    // Exact match on the resolved or raw name wins; otherwise a unique prefix
    // match. Several prefix matches are ambiguous and reported, never guessed.
    public static string? FindMatch(IEnumerable<AppEntry> entries, string name, string resolved)
    {
        var prefixes = new List<AppEntry>();
        foreach (var entry in entries)
        {
            if (entry.Name.Equals(resolved, StringComparison.OrdinalIgnoreCase) ||
                entry.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return entry.Target;
            }
            if (entry.Name.StartsWith(resolved, StringComparison.OrdinalIgnoreCase))
            {
                prefixes.Add(entry);
            }
        }
        return prefixes switch
        {
            [] => null,
            [var only] => only.Target,
            _ => throw new InvalidOperationException(
                $"Ambiguous app name '{name}'; candidates: {string.Join(", ", prefixes.Select(e => e.Name).Distinct())}"),
        };
    }

    public static IEnumerable<AppEntry> StartMenuShortcuts()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
        };
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
        return roots.Where(Directory.Exists)
            .SelectMany(root => Directory.EnumerateFiles(root, "*.lnk", options))
            .Select(path => new AppEntry(Path.GetFileNameWithoutExtension(path), path));
    }

    // Every Start-registered app, including MSIX/AppX packages that have no
    // .lnk on disk. Item paths are AppUserModelIDs launchable via shell:AppsFolder.
    public static IEnumerable<AppEntry> AppsFolderEntries()
    {
        var entries = new List<AppEntry>();
        try
        {
            var shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType is null)
            {
                return entries;
            }
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic items = shell.NameSpace("shell:AppsFolder").Items();
            for (var i = 0; i < (int)items.Count; i++)
            {
                dynamic item = items.Item(i);
                entries.Add(new AppEntry((string)item.Name, $@"shell:AppsFolder\{(string)item.Path}"));
            }
        }
        catch (Exception err) when (err is COMException or InvalidCastException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
        }
        return entries;
    }

    public static async Task<string> OpenAsync(string name, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new ArgumentException("open_app requires app_name");
        }
        var resolved = Resolve(name);

        if (ActivateRunning(name, resolved))
        {
            await Task.Delay(300, cancellationToken);
            return $"switched to {resolved}";
        }

        var target = FindMatch(StartMenuShortcuts().Concat(AppsFolderEntries()), name, resolved)
            ?? (ShellCommands.TryGetValue(resolved, out var command) ? command : resolved);
        try
        {
            using var process = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })
                ?? throw new InvalidOperationException($"Application not found: {name}");
        }
        catch (Exception err) when (err is System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            throw new InvalidOperationException($"Application not found: {name}");
        }
        await Task.Delay(1_000, cancellationToken);
        return $"opened {resolved}";
    }

    // Brings forward the first visible top-level window whose process name or
    // title matches; a minimized window is restored first. A live window that
    // foreground-lock rules refuse to raise is an error, never a relaunch or a
    // silent success.
    private static bool ActivateRunning(string name, string resolved)
    {
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                IntPtr handle;
                try
                {
                    handle = process.MainWindowHandle;
                    if (handle == IntPtr.Zero || !Matches(process, name, resolved))
                    {
                        continue;
                    }
                }
                catch (Exception err) when (err is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    continue; // exited or inaccessible mid-enumeration
                }
                if (IsIconic(handle))
                {
                    _ = ShowWindow(handle, 9); // SW_RESTORE
                }
                if (!SetForegroundWindow(handle))
                {
                    throw new InvalidOperationException(
                        $"{resolved} is running but Windows refused to bring it to the foreground");
                }
                return true;
            }
        }
        return false;
    }

    private static bool Matches(Process process, string name, string resolved)
    {
        var compact = resolved.Replace(" ", "", StringComparison.Ordinal);
        return process.ProcessName.Equals(compact, StringComparison.OrdinalIgnoreCase) ||
            process.ProcessName.Equals(name, StringComparison.OrdinalIgnoreCase) ||
            process.MainWindowTitle.Equals(resolved, StringComparison.OrdinalIgnoreCase) ||
            process.MainWindowTitle.EndsWith("- " + resolved, StringComparison.OrdinalIgnoreCase);
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(IntPtr hwnd, int command);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsIconic(IntPtr hwnd);
}
