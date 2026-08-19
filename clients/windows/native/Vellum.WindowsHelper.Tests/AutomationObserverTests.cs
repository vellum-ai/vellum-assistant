using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class AutomationObserverTests
{
    public static async ValueTask RunAsync()
    {
        TestStableIdsAndDiff();
        TestWindowTargetSelection();
        await TestFullThenDiffAsync();
        await TestSessionIsolationAndExpiryAsync();
        await TestUnavailableAsync();
        await TestCancellationAsync();
        Console.WriteLine("Automation observer tests passed");
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

    private static async ValueTask TestFullThenDiffAsync()
    {
        var source = new FakeSource { Snapshot = Snapshot(Node(1, children: [Node(2, name: "Save")])) };
        var module = Module(source);
        var full = await ObserveAsync(module, "conv-1", "full");
        Check(full.GetProperty("kind").GetString() == "full", "first observation is full");
        Check(full.GetProperty("tree").GetString()!.Contains("\"Save\"", StringComparison.Ordinal),
            "full observation serializes the tree");
        Check(full.GetProperty("secondaryWindows").GetString()!.Contains("\"Other\"", StringComparison.Ordinal),
            "secondary windows are reported");
        Check(full.GetProperty("foregroundApp").GetProperty("name").GetString() == "notepad",
            "foreground app metadata is reported");
        Check(!full.TryGetProperty("unavailable", out _), "successful results omit null fields");

        source.Snapshot = Snapshot(Node(1, children: [Node(2, name: "Saved", focused: true)]));
        var diff = await ObserveAsync(module, "conv-1", "diff");
        Check(diff.GetProperty("kind").GetString() == "diff" && diff.TryGetProperty("tree", out _),
            "diff observations include the current tree");
        Check(diff.GetProperty("diff").GetString()!.Contains("\"Saved\"", StringComparison.Ordinal),
            "diff contains the changed node");

        var unchanged = await ObserveAsync(module, "conv-1", "diff");
        Check(!unchanged.TryGetProperty("diff", out _),
            "unchanged observations omit the diff");
    }

    private static async ValueTask TestSessionIsolationAndExpiryAsync()
    {
        var source = new FakeSource { Snapshot = Snapshot(Node(1)) };
        var now = DateTimeOffset.UtcNow;
        var store = new ObservationSessionStore(TimeSpan.FromMinutes(10), () => now);
        var module = new AutomationObserverModule(new AutomationObserver(source, store));
        _ = await ObserveAsync(module, "conv-1", "full");
        var other = await ObserveAsync(module, "conv-2", "diff");
        Check(other.GetProperty("kind").GetString() == "full", "sessions are per conversation");
        now += TimeSpan.FromMinutes(11);
        var expired = await ObserveAsync(module, "conv-1", "diff");
        Check(expired.GetProperty("kind").GetString() == "full",
            "expired sessions fall back to full observations");
    }

    private static async ValueTask TestUnavailableAsync()
    {
        var source = new FakeSource { Snapshot = Snapshot(Node(1)) };
        var module = Module(source);
        _ = await ObserveAsync(module, "conv-1", "full");
        source.Snapshot = new AutomationSnapshot(
            null, null, [], new Unavailable(Unavailable.ElevatedOrProtected, "denied"));
        var denied = await ObserveAsync(module, "conv-1", "diff");
        Check(denied.GetProperty("unavailable").GetProperty("code").GetString() == Unavailable.ElevatedOrProtected &&
            !denied.TryGetProperty("tree", out _),
            "denied targets return a structured unavailable result and no tree");

        source.Snapshot = Snapshot(Node(1));
        var after = await ObserveAsync(module, "conv-1", "diff");
        Check(after.GetProperty("kind").GetString() == "full",
            "denied targets never leave a stale diff baseline");

        source.Snapshot = new AutomationSnapshot(
            null, null, [], new Unavailable(Unavailable.NoForeground, "none"));
        var noFocus = await ObserveAsync(module, "conv-1", "full");
        Check(noFocus.GetProperty("unavailable").GetProperty("code").GetString() == Unavailable.NoForeground,
            "missing focus reports no_foreground");
    }

    private static async ValueTask TestCancellationAsync()
    {
        var module = Module(new FakeSource { Snapshot = Snapshot(Node(1)) });
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            _ = await module.InvokeAsync(
                "automation.observe", Params(new { conversationId = "conv-1" }), cancelled.Token);
            throw new Exception("Cancellation was ignored");
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static AutomationObserverModule Module(FakeSource source) =>
        new(new AutomationObserver(source, new ObservationSessionStore(TimeSpan.FromMinutes(10))));

    private static async ValueTask<JsonElement> ObserveAsync(
        AutomationObserverModule module, string conversationId, string mode)
    {
        var result = await module.InvokeAsync(
            "automation.observe", Params(new { conversationId, mode }), CancellationToken.None);
        return (JsonElement)result!;
    }

    private static JsonElement Params<T>(T value) => JsonSerializer.SerializeToElement(value);

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
