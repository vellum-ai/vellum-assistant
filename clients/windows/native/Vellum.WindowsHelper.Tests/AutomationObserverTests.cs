using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class AutomationObserverTests
{
    public static ValueTask RunAsync()
    {
        TestStableIdsAndDiff();
        TestWindowTargetSelection();
        TestFullThenDiff();
        TestSessionIsolationAndExpiry();
        TestUnavailable();
        TestCancellation();
        Console.WriteLine("Automation observer tests passed");
        return ValueTask.CompletedTask;
    }

    private static void TestWindowTargetSelection()
    {
        var helper = new WindowCandidate(new IntPtr(1), 10, true, false);
        var host = new WindowCandidate(new IntPtr(2), 20, true, false);
        var target = new WindowCandidate(new IntPtr(3), 30, true, false);
        Check(
            WindowTargetSelector.Select(host, 10, 20, [helper, host, target]) == target.Handle,
            "host focus selects the topmost non-host window");
        Check(
            WindowTargetSelector.Select(target, 10, 20, [host]) == target.Handle,
            "non-host foreground windows stay selected");
        Check(
            WindowTargetSelector.Select(host, 10, 20, [target with { Minimized = true }]) == IntPtr.Zero,
            "minimized windows are not selected");
    }

    private static void TestStableIdsAndDiff()
    {
        Check(
            AutomationIds.FromRuntimeId([7, 42], "f") == AutomationIds.FromRuntimeId([7, 42], "other"),
            "runtime id maps stably");
        Check(
            AutomationIds.FromRuntimeId([], "p1n2") == AutomationIds.FromRuntimeId(null, "p1n2"),
            "empty runtime id uses fallback");
        Check(
            AutomationIds.FromRuntimeId([7, 42], "f") != AutomationIds.FromRuntimeId([7, 43], "f"),
            "different runtime ids differ");
        var before = Node(1, children: [Node(2, name: "Save"), Node(3, name: "Cancel")]);
        var after = Node(1, children: [Node(2, name: "Saved", focused: true), Node(4, name: "Close")]);
        var diff = AutomationTreeDiff.Compute(before, after);
        Check(diff.Added.Count == 1 && diff.Added[0].Id == 4 && diff.Added[0].Children.Count == 0,
            "diff reports added nodes shallowly");
        Check(diff.Changed.Count == 1 && diff.Changed[0].Id == 2, "diff reports changed nodes");
        Check(diff.RemovedIds.SequenceEqual([3]), "diff reports removed ids");
    }

    private static void TestFullThenDiff()
    {
        var source = new FakeSource { Snapshot = Snapshot(Node(1, children: [Node(2, name: "Save")])) };
        var observer = Observer(source);
        var full = observer.Observe("conv-1", "full", CancellationToken.None);
        Check(full.Kind == "full", "first observation is full");
        Check(full.Tree?.Contains("\"Save\"", StringComparison.Ordinal) == true,
            "full observation serializes the tree");
        Check(full.SecondaryWindows.Contains("\"Other\"", StringComparison.Ordinal),
            "secondary windows are reported");
        Check(full.ForegroundApp?.Name == "notepad", "foreground app metadata is reported");
        Check(full.Unavailable is null, "successful results omit unavailable reasons");

        source.Snapshot = Snapshot(Node(1, children: [Node(2, name: "Saved", focused: true)]));
        var diff = observer.Observe("conv-1", "diff", CancellationToken.None);
        Check(diff.Kind == "diff" && diff.Tree is not null,
            "diff observations include the current tree");
        Check(diff.Diff?.Contains("\"Saved\"", StringComparison.Ordinal) == true,
            "diff contains the changed node");

        var unchanged = observer.Observe("conv-1", "diff", CancellationToken.None);
        Check(unchanged.Diff is null, "unchanged observations omit the diff");
    }

    private static void TestSessionIsolationAndExpiry()
    {
        var source = new FakeSource { Snapshot = Snapshot(Node(1)) };
        var now = DateTimeOffset.UtcNow;
        var observer = new AutomationObserver(
            source, new ObservationSessionStore(TimeSpan.FromMinutes(10), () => now));
        _ = observer.Observe("conv-1", "full", CancellationToken.None);
        Check(observer.Observe("conv-2", "diff", CancellationToken.None).Kind == "full",
            "sessions are per conversation");
        now += TimeSpan.FromMinutes(11);
        Check(observer.Observe("conv-1", "diff", CancellationToken.None).Kind == "full",
            "expired sessions fall back to full observations");
    }

    private static void TestUnavailable()
    {
        var source = new FakeSource { Snapshot = Snapshot(Node(1)) };
        var observer = Observer(source);
        _ = observer.Observe("conv-1", "full", CancellationToken.None);
        source.Snapshot = new AutomationSnapshot(
            null, null, [], new Unavailable(Unavailable.ElevatedOrProtected, "denied"));
        var denied = observer.Observe("conv-1", "diff", CancellationToken.None);
        Check(denied.Unavailable?.Code == Unavailable.ElevatedOrProtected && denied.Tree is null,
            "denied targets return a structured unavailable result and no tree");

        source.Snapshot = Snapshot(Node(1));
        Check(observer.Observe("conv-1", "diff", CancellationToken.None).Kind == "full",
            "denied targets never leave a stale diff baseline");

        source.Snapshot = new AutomationSnapshot(
            null, null, [], new Unavailable(Unavailable.NoForeground, "none"));
        Check(observer.Observe("conv-1", "full", CancellationToken.None).Unavailable?.Code ==
            Unavailable.NoForeground, "missing focus reports no_foreground");
    }

    private static void TestCancellation()
    {
        var observer = Observer(new FakeSource { Snapshot = Snapshot(Node(1)) });
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            _ = observer.Observe("conv-1", "full", cancelled.Token);
            throw new Exception("Cancellation was ignored");
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static AutomationObserver Observer(FakeSource source) =>
        new(source, new ObservationSessionStore(TimeSpan.FromMinutes(10)));

    private static AutomationSnapshot Snapshot(AutomationNode tree) =>
        new(
            tree,
            new ForegroundApp("notepad", 1234, "Untitled"),
            [
                new WindowInfo(11, "Untitled", new PixelRect(0, 0, 800, 600), true),
                new WindowInfo(12, "Other", new PixelRect(800, 0, 400, 300), false),
            ],
            null);

    private static AutomationNode Node(
        long id, string? name = null, bool focused = false, IReadOnlyList<AutomationNode>? children = null) =>
        new(id, "ControlType.Button", name, null, focused, false, false, true,
            new PixelRect(0, 0, 100, 40), children ?? []);

    private static void Check(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"Automation observer assertion failed: {label}");
        }
    }

    private sealed class FakeSource : IAutomationSnapshotSource
    {
        public required AutomationSnapshot Snapshot { get; set; }

        public AutomationSnapshot TakeSnapshot(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Snapshot;
        }
    }
}
