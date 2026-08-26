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

    // Case-insensitive match on a shortcut's file name, trying the resolved
    // name and the raw name; an exact match beats a prefix match.
    public static string? FindShortcut(IEnumerable<string> shortcutPaths, string name, string resolved)
    {
        string? prefix = null;
        foreach (var path in shortcutPaths)
        {
            var stem = Path.GetFileNameWithoutExtension(path);
            if (stem.Equals(resolved, StringComparison.OrdinalIgnoreCase) ||
                stem.Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return path;
            }
            prefix ??= stem.StartsWith(resolved, StringComparison.OrdinalIgnoreCase) ? path : null;
        }
        return prefix;
    }

    public static IEnumerable<string> StartMenuShortcuts()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
        };
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
        return roots.Where(Directory.Exists).SelectMany(root => Directory.EnumerateFiles(root, "*.lnk", options));
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

        var target = FindShortcut(StartMenuShortcuts(), name, resolved)
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
    // title matches; a minimized window is restored first.
    private static bool ActivateRunning(string name, string resolved)
    {
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.MainWindowHandle == IntPtr.Zero || !Matches(process, name, resolved))
                {
                    continue;
                }
                if (IsIconic(process.MainWindowHandle))
                {
                    _ = ShowWindow(process.MainWindowHandle, 9); // SW_RESTORE
                }
                return SetForegroundWindow(process.MainWindowHandle);
            }
        }
        return false;
    }

    private static bool Matches(Process process, string name, string resolved)
    {
        string title;
        try
        {
            title = process.MainWindowTitle;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        var compact = resolved.Replace(" ", "", StringComparison.Ordinal);
        return process.ProcessName.Equals(compact, StringComparison.OrdinalIgnoreCase) ||
            process.ProcessName.Equals(name, StringComparison.OrdinalIgnoreCase) ||
            title.Equals(resolved, StringComparison.OrdinalIgnoreCase) ||
            title.EndsWith("- " + resolved, StringComparison.OrdinalIgnoreCase);
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
