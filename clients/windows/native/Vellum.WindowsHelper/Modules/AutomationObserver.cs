using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;
using Vellum.WindowsHelper.Rpc;

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
            return new ObservationResult("full", null, null, snapshot.ForegroundApp, windowsJson, reason);
        }
        var previous = sessions.Exchange(conversationId, snapshot.Tree, mode == "diff");
        if (previous is null)
        {
            var tree = AutomationJson.ToJson(snapshot.Tree);
            return new ObservationResult("full", tree, null, snapshot.ForegroundApp, windowsJson, null);
        }
        var diff = AutomationJson.ToJson(AutomationTreeDiff.Compute(previous, snapshot.Tree));
        return new ObservationResult("diff", null, diff, snapshot.ForegroundApp, windowsJson, null);
    }
}

public sealed class AutomationObserverModule : IRpcModule
{
    private readonly AutomationObserver _observer;

    public AutomationObserverModule()
        : this(new AutomationObserver(
            new UiaSnapshotSource(), new ObservationSessionStore(TimeSpan.FromMinutes(15)))) { }

    public AutomationObserverModule(AutomationObserver observer) => _observer = observer;

    public IReadOnlyCollection<string> Methods { get; } = ["automation.observe"];

    public ValueTask<object?> InvokeAsync(string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        var request = parameters?.Deserialize<ObserveParams>(AutomationJson.Options);
        if (request is null || string.IsNullOrEmpty(request.ConversationId))
        {
            throw new ArgumentException("conversationId is required");
        }
        var mode = request.Mode == "diff" ? "diff" : "full";
        var result = _observer.Observe(request.ConversationId, mode, cancellationToken);
        return ValueTask.FromResult<object?>(AutomationJson.ToElement(result));
    }

    private sealed record ObserveParams(string? ConversationId, string? Mode);
}

/// <summary>
/// Live UI Automation snapshot of the foreground app: a bounded control-view tree walk plus the
/// app's other top-level windows. Elevated or protected targets surface as unavailable, never stale.
/// </summary>
public sealed class UiaSnapshotSource : IAutomationSnapshotSource
{
    private const int MaxDepth = 12;
    private const int MaxNodes = 2000;

    public AutomationSnapshot TakeSnapshot(CancellationToken cancellationToken)
    {
        ObserverNativeMethods.EnsureDpiAwareness();
        var foreground = ObserverNativeMethods.GetForegroundWindow();
        if (foreground == IntPtr.Zero)
        {
            return new AutomationSnapshot(
                null, null, [], new Unavailable(Unavailable.NoForeground, "No window has foreground focus"));
        }
        try
        {
            var root = AutomationElement.FromHandle(foreground);
            var nodeCount = 0;
            var tree = BuildNode(root, 0, ref nodeCount, cancellationToken);
            var app = ReadForegroundApp(foreground, tree.Name);
            var windows = ListAppWindows(app?.ProcessId ?? 0, foreground, cancellationToken);
            return new AutomationSnapshot(tree, app, windows, null);
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or UnauthorizedAccessException or COMException)
        {
            return new AutomationSnapshot(null, null, [], new Unavailable(
                Unavailable.ElevatedOrProtected, "The foreground target cannot be observed without elevation"));
        }
    }

    private static AutomationNode BuildNode(
        AutomationElement element, int depth, ref int nodeCount, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        nodeCount++;
        var info = element.Current;
        var (value, editable) = ReadValueState(element, info.IsPassword);
        var children = new List<AutomationNode>();
        if (depth < MaxDepth)
        {
            var walker = TreeWalker.ControlViewWalker;
            for (var child = walker.GetFirstChild(element);
                child is not null && nodeCount < MaxNodes;
                child = walker.GetNextSibling(child))
            {
                children.Add(BuildNode(child, depth + 1, ref nodeCount, cancellationToken));
            }
        }
        return new AutomationNode(
            AutomationIds.FromRuntimeId(element.GetRuntimeId(), $"p{depth}n{nodeCount}"),
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
        catch (ArgumentException)
        {
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
    private static bool _dpiApplied;

    // Per-monitor-v2 keeps UIA bounds in physical pixels. Fails harmlessly
    // when another module already set the process context.
    internal static void EnsureDpiAwareness()
    {
        if (!_dpiApplied)
        {
            _dpiApplied = true;
            _ = SetProcessDpiAwarenessContext(new IntPtr(-4));
        }
    }

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern int SetProcessDpiAwarenessContext(IntPtr context);
}
