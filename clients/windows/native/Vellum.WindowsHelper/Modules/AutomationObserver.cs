using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace Vellum.WindowsHelper.Modules;

/// <summary>Snapshot provider abstraction so observation logic is testable off Windows UIA.</summary>
public interface IAutomationSnapshotSource
{
    AutomationSnapshot TakeSnapshot(CancellationToken cancellationToken);
}

/// <summary>Per-conversation previous trees with a sliding TTL, used for diff observations.</summary>
public sealed class ObservationSessionStore(TimeSpan ttl, Func<DateTimeOffset>? clock = null)
{
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly object _gate = new();
    private readonly Dictionary<string, (AutomationNode Tree, DateTimeOffset Touched)> _sessions =
        new(StringComparer.Ordinal);

    /// <summary>Stores the new tree (null clears the session) and returns the unexpired previous tree when requested.</summary>
    public AutomationNode? Exchange(string conversationId, AutomationNode? tree, bool readPrevious)
    {
        lock (_gate)
        {
            var cutoff = _clock() - ttl;
            foreach (var key in _sessions.Keys.Where(key => _sessions[key].Touched <= cutoff).ToList())
            {
                _sessions.Remove(key);
            }
            var previous = readPrevious && _sessions.TryGetValue(conversationId, out var entry)
                ? entry.Tree
                : null;
            if (tree is null)
            {
                _sessions.Remove(conversationId);
                return previous;
            }
            _sessions[conversationId] = (tree, _clock());
            return previous;
        }
    }
}

public sealed class AutomationObserver(IAutomationSnapshotSource source, ObservationSessionStore sessions)
{
    public ObservationResult Observe(string conversationId, string mode, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var snapshot = source.TakeSnapshot(cancellationToken);
        var windowsJson = AutomationJson.ToJson(snapshot.SecondaryWindows);
        if (snapshot.Unavailable is not null || snapshot.Tree is null)
        {
            // Drop the session so a later diff can never report against a pre-denial tree.
            _ = sessions.Exchange(conversationId, null, false);
            var reason = snapshot.Unavailable
                ?? new Unavailable(Unavailable.NoForeground, "No foreground window is available");
            return new ObservationResult(
                "full", null, null, snapshot.ForegroundApp, windowsJson, null, reason);
        }
        var previous = sessions.Exchange(conversationId, snapshot.Tree, mode == "diff");
        if (previous is null)
        {
            var tree = AutomationJson.ToJson(snapshot.Tree);
            return new ObservationResult(
                "full", tree, null, snapshot.ForegroundApp, windowsJson, snapshot.Tree.Bounds, null);
        }
        var currentTree = AutomationJson.ToJson(snapshot.Tree);
        var changes = AutomationTreeDiff.Compute(previous, snapshot.Tree);
        var diff = changes is { Added.Count: 0, Changed.Count: 0, RemovedIds.Count: 0 }
            ? null
            : AutomationJson.ToJson(changes);
        return new ObservationResult(
            "diff", currentTree, diff, snapshot.ForegroundApp, windowsJson, snapshot.Tree.Bounds, null);
    }
}

/// <summary>
/// Live UI Automation snapshot of the foreground app: a bounded control-view tree walk plus the
/// app's other top-level windows. Elevated or protected targets surface as unavailable, never stale.
/// </summary>
public sealed class UiaSnapshotSource : IAutomationSnapshotSource
{
    private const int MaxDepth = 12;
    private const int MaxNodes = 2000;
    private readonly IWindowTargetSource _windows;

    public UiaSnapshotSource()
        : this(new WindowsWindowTargetSource())
    {
    }

    public UiaSnapshotSource(IWindowTargetSource windows) => _windows = windows;

    public AutomationSnapshot TakeSnapshot(CancellationToken cancellationToken)
    {
        ProcessDpi.EnsureAwareness();
        var foreground = _windows.GetTargetWindow();
        if (foreground == IntPtr.Zero)
        {
            return new AutomationSnapshot(
                null, null, [], new Unavailable(Unavailable.NoForeground, "No window has foreground focus"));
        }
        try
        {
            var root = AutomationElement.FromHandle(foreground);
            var nodeCount = 0;
            var tree = BuildNode(root, 0, "0", ref nodeCount, cancellationToken);
            var app = ReadForegroundApp(foreground, tree.Name);
            var windows = ListAppWindows(app?.ProcessId ?? 0, foreground, cancellationToken);
            return new AutomationSnapshot(tree, app, windows, null);
        }
        catch (ElementNotAvailableException)
        {
            // The UI mutated mid-walk; a transient miss is not an access denial.
            return new AutomationSnapshot(null, null, [], new Unavailable(
                Unavailable.NotFound, "The foreground window changed during observation"));
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or COMException)
        {
            return new AutomationSnapshot(null, null, [], new Unavailable(
                Unavailable.ElevatedOrProtected, "The foreground target cannot be observed without elevation"));
        }
    }

    private static AutomationNode BuildNode(
        AutomationElement element, int depth, string path, ref int nodeCount, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        nodeCount++;
        var info = element.Current;
        var (value, editable) = ReadValueState(element, info.IsPassword);
        var children = new List<AutomationNode>();
        if (depth < MaxDepth)
        {
            var walker = TreeWalker.ControlViewWalker;
            var childIndex = 0;
            for (var child = walker.GetFirstChild(element);
                child is not null && nodeCount < MaxNodes;
                child = walker.GetNextSibling(child))
            {
                children.Add(BuildNode(child, depth + 1, $"{path}.{childIndex++}", ref nodeCount, cancellationToken));
            }
        }
        return new AutomationNode(
            // Sibling-index path fallback stays stable when other subtrees change.
            AutomationIds.FromRuntimeId(element.GetRuntimeId(), "p" + path),
            info.ControlType?.ProgrammaticName ?? "ControlType.Custom",
            NullIfEmpty(info.Name),
            value,
            info.HasKeyboardFocus,
            IsSelected(element),
            editable,
            info.IsEnabled,
            ToPixelRect(info.BoundingRectangle),
            children);
    }

    private static (string? Value, bool Editable) ReadValueState(AutomationElement element, bool isPassword)
    {
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) ||
            pattern is not ValuePattern valuePattern)
        {
            return (null, false);
        }
        var current = valuePattern.Current;
        return (isPassword ? null : NullIfEmpty(current.Value), !current.IsReadOnly && !isPassword);
    }

    private static bool IsSelected(AutomationElement element) =>
        element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var pattern) &&
        pattern is SelectionItemPattern item && item.Current.IsSelected;

    private static ForegroundApp? ReadForegroundApp(IntPtr hwnd, string? windowTitle)
    {
        _ = ObserverNativeMethods.GetWindowThreadProcessId(hwnd, out var processId);
        if (processId == 0)
        {
            return null;
        }
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById((int)processId);
            return new ForegroundApp(process.ProcessName, (int)processId, windowTitle);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // The process exited between lookup and name read, or was never there.
            return new ForegroundApp("unknown", (int)processId, windowTitle);
        }
    }

    private static IReadOnlyList<WindowInfo> ListAppWindows(
        int processId, IntPtr foreground, CancellationToken cancellationToken)
    {
        if (processId == 0)
        {
            return [];
        }
        var windows = new List<WindowInfo>();
        var found = AutomationElement.RootElement.FindAll(
            TreeScope.Children,
            new PropertyCondition(AutomationElement.ProcessIdProperty, processId));
        foreach (AutomationElement window in found)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var info = window.Current;
            windows.Add(new WindowInfo(
                info.NativeWindowHandle,
                info.Name ?? string.Empty,
                ToPixelRect(info.BoundingRectangle),
                info.NativeWindowHandle == foreground.ToInt64()));
        }
        return windows;
    }

    private static PixelRect ToPixelRect(System.Windows.Rect rect) =>
        rect.IsEmpty || double.IsNaN(rect.X) || double.IsInfinity(rect.X) || double.IsInfinity(rect.Width)
            ? new PixelRect(0, 0, 0, 0)
            : new PixelRect(
                (int)Math.Round(rect.X), (int)Math.Round(rect.Y),
                (int)Math.Round(rect.Width), (int)Math.Round(rect.Height));

    private static string? NullIfEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}

file static class ObserverNativeMethods
{
    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}

public interface IWindowTargetSource
{
    IntPtr GetTargetWindow();
}

public sealed record WindowCandidate(IntPtr Handle, uint ProcessId, bool Visible, bool Minimized);

public static class WindowTargetSelector
{
    public static IntPtr Select(
        WindowCandidate foreground,
        uint helperProcessId,
        uint hostProcessId,
        IReadOnlyList<WindowCandidate> zOrderedWindows)
    {
        if (IsTarget(foreground, helperProcessId, hostProcessId))
        {
            return foreground.Handle;
        }
        return zOrderedWindows
            .FirstOrDefault(window => IsTarget(window, helperProcessId, hostProcessId))
            ?.Handle ?? IntPtr.Zero;
    }

    private static bool IsTarget(WindowCandidate window, uint helperProcessId, uint hostProcessId) =>
        window.Handle != IntPtr.Zero && window.Visible && !window.Minimized &&
        window.ProcessId != helperProcessId && window.ProcessId != hostProcessId;
}

public sealed class WindowsWindowTargetSource : IWindowTargetSource
{
    public const string HostProcessIdEnvironmentVariable = "VELLUM_HOST_PID";

    private readonly uint _helperProcessId = (uint)Environment.ProcessId;
    private readonly uint _hostProcessId = ReadHostProcessId();

    public IntPtr GetTargetWindow()
    {
        var foregroundHandle = TargetWindowNativeMethods.GetForegroundWindow();
        var foreground = Candidate(foregroundHandle);
        var windows = new List<WindowCandidate>();
        _ = TargetWindowNativeMethods.EnumWindows((handle, _) =>
        {
            if (handle != TargetWindowNativeMethods.GetShellWindow())
            {
                windows.Add(Candidate(handle));
            }
            return true;
        }, IntPtr.Zero);
        var target = WindowTargetSelector.Select(
            foreground, _helperProcessId, _hostProcessId, windows);
        if (target != IntPtr.Zero && target != foregroundHandle)
        {
            _ = TargetWindowNativeMethods.SetForegroundWindow(target);
        }
        return target;
    }

    private static WindowCandidate Candidate(IntPtr handle)
    {
        _ = ObserverNativeMethods.GetWindowThreadProcessId(handle, out var processId);
        return new WindowCandidate(
            handle,
            processId,
            IsApplicationWindow(handle),
            TargetWindowNativeMethods.IsIconic(handle));
    }

    private static bool IsApplicationWindow(IntPtr handle)
    {
        if (!TargetWindowNativeMethods.IsWindowVisible(handle))
        {
            return false;
        }
        var candidate = TargetWindowNativeMethods.GetAncestor(handle, 3);
        while (true)
        {
            var popup = TargetWindowNativeMethods.GetLastActivePopup(candidate);
            if (popup == candidate)
            {
                break;
            }
            candidate = popup;
            if (TargetWindowNativeMethods.IsWindowVisible(candidate))
            {
                break;
            }
        }
        return candidate == handle;
    }

    private static uint ReadHostProcessId() =>
        uint.TryParse(
            Environment.GetEnvironmentVariable(HostProcessIdEnvironmentVariable),
            out var processId)
            ? processId
            : 0;
}

file static class TargetWindowNativeMethods
{
    internal delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr parameter);

    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetLastActivePopup(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetShellWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(IntPtr hwnd);
}
