using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class AppControlTests
{
    public static async Task RunAsync()
    {
        await TestPinnedSessionAsync();
        await TestForegroundGateAsync();
        await TestCoordinatesAsync();
        await TestSequenceOwnershipAsync();
        TestTargetSelection();
        TestSessionExpiry();
        Console.WriteLine("App control tests passed");
    }

    private static async Task TestPinnedSessionAsync()
    {
        var host = new FakeHost();
        var module = new AppControl(host);

        var beforeStart = await InvokeAsync(
            module, "conv-1", "app_control_press", "{\"tool\":\"press\",\"app\":\"notepad\",\"key\":\"a\"}");
        CheckContains(beforeStart, "No native app-control session", "actions require a native session");

        var started = await InvokeAsync(
            module, "conv-1", "app_control_start", "{\"tool\":\"start\",\"app\":\"notepad\"}");
        Check(started.GetValueOrDefault("state") as string == "running", "start reports running");
        Check(started.GetValueOrDefault("pngBase64") as string == "png", "start captures target");
        var bounds = (Dictionary<string, object?>)started["windowBounds"]!;
        Check((int?)bounds["width"] == 800, "bounds use the daemon wire shape");

        var competingStart = await InvokeAsync(
            module, "conv-other", "app_control_start", "{\"tool\":\"start\",\"app\":\"notepad\"}");
        Check(
            competingStart.GetValueOrDefault("state") as string == "running",
            "native sessions stay scoped without duplicating daemon ownership");

        var wrongApp = await InvokeAsync(
            module, "conv-1", "app_control_press", "{\"tool\":\"press\",\"app\":\"calculator\",\"key\":\"a\"}");
        CheckContains(wrongApp, "No native app-control session", "session pins the approved app string");
        Check(host.PressCount == 0, "mismatched app sends no input");

        host.Alive = false;
        var exited = await InvokeAsync(
            module, "conv-1", "app_control_press", "{\"tool\":\"press\",\"app\":\"notepad\",\"key\":\"a\"}");
        CheckContains(exited, "App not running", "reused process ids fail the pinned identity check");
        Check(host.PressCount == 0, "dead targets send no input");
    }

    private static async Task TestForegroundGateAsync()
    {
        var host = new FakeHost();
        var module = new AppControl(host);
        await InvokeAsync(
            module, "conv-2", "app_control_start", "{\"tool\":\"start\",\"app\":\"notepad\"}");

        host.Foreground = false;
        var blocked = await InvokeAsync(
            module, "conv-2", "app_control_type", "{\"tool\":\"type\",\"app\":\"notepad\",\"text\":\"hello\"}");
        CheckContains(blocked, "does not own foreground focus", "focus theft blocks typing");
        Check(host.TypedText is null, "focus theft sends no text");

        host.Foreground = true;
        var typed = await InvokeAsync(
            module, "conv-2", "app_control_type", "{\"tool\":\"type\",\"app\":\"notepad\",\"text\":\"hello\"}");
        Check(!typed.ContainsKey("executionError"), "focused target accepts typing");
        Check(host.TypedText == "hello", "text is forwarded after ownership verification");
    }

    private static async Task TestCoordinatesAsync()
    {
        var host = new FakeHost();
        var module = new AppControl(host);
        await InvokeAsync(
            module, "conv-3", "app_control_start", "{\"tool\":\"start\",\"app\":\"notepad\"}");

        var outside = await InvokeAsync(
            module,
            "conv-3",
            "app_control_click",
            "{\"tool\":\"click\",\"app\":\"notepad\",\"x\":800,\"y\":20}");
        CheckContains(outside, "outside the target window", "window-relative bounds are enforced");
        Check(host.Click is null, "out-of-bounds clicks are not synthesized");

        var clicked = await InvokeAsync(
            module,
            "conv-3",
            "app_control_click",
            "{\"tool\":\"click\",\"app\":\"notepad\",\"x\":25,\"y\":30,\"button\":\"right\"}");
        Check(!clicked.ContainsKey("executionError"), "in-bounds click succeeds");
        Check(host.Click == (125d, 230d, "right"), "window coordinates translate to screen pixels");
    }

    private static async Task TestSequenceOwnershipAsync()
    {
        var host = new FakeHost();
        var module = new AppControl(host);
        await InvokeAsync(
            module, "conv-4", "app_control_start", "{\"tool\":\"start\",\"app\":\"notepad\"}");

        var invalid = await InvokeAsync(
            module,
            "conv-4",
            "app_control_sequence",
            "{\"tool\":\"sequence\",\"app\":\"notepad\",\"steps\":[{\"key\":\"a\"},{\"key\":\"not-a-key\"}]}");
        CheckContains(invalid, "Unsupported key", "sequences validate every step before input");
        Check(host.PressCount == 0, "invalid sequences do not partially execute");

        host.ForegroundChecksRemaining = 1;

        var result = await InvokeAsync(
            module,
            "conv-4",
            "app_control_sequence",
            "{\"tool\":\"sequence\",\"app\":\"notepad\",\"steps\":[{\"key\":\"a\"},{\"key\":\"b\"}]}");
        CheckContains(result, "lost foreground ownership", "sequence rechecks ownership per step");
        Check(host.PressCount == 1, "sequence stops before input reaches a new foreground owner");
    }

    private static void TestSessionExpiry()
    {
        var now = DateTimeOffset.UtcNow;
        var store = new AppControlSessionStore(TimeSpan.FromSeconds(10), () => now);
        var target = new AppTarget(123, "notepad", 456);
        store.Set("conv", "notepad", target);
        Check(store.Get("conv", "NOTEPAD")?.Target == target, "session app matching is case-insensitive");
        now = now.AddSeconds(11);
        Check(store.Get("conv", "notepad") is null, "idle sessions expire");
    }

    private static void TestTargetSelection()
    {
        var browser = new AppTarget(100, "browser", 1);
        var renderer = new AppTarget(101, "browser", 2);
        var gpu = new AppTarget(102, "browser", 3);
        var candidates = new[] { browser, renderer, gpu };

        var selected = AppTargetSelector.Resolve(
            "browser", candidates, new HashSet<int> { browser.ProcessId }, renderer.ProcessId);
        Check(selected.Target == browser, "the process with a visible window wins over child processes");

        var focused = AppTargetSelector.Resolve(
            "browser",
            candidates,
            new HashSet<int> { browser.ProcessId, renderer.ProcessId },
            renderer.ProcessId);
        Check(focused.Target == renderer, "foreground ownership disambiguates multiple app windows");

        var headless = AppTargetSelector.Resolve(
            "browser", candidates, new HashSet<int>(), browser.ProcessId);
        Check(
            headless.Error?.Contains("no visible top-level window", StringComparison.Ordinal) == true,
            "headless processes are not selected or relaunched");
    }

    private static async Task<Dictionary<string, object?>> InvokeAsync(
        AppControl module, string conversationId, string toolName, string inputJson)
    {
        using var document = JsonDocument.Parse(
            $"{{\"requestId\":\"req-1\",\"conversationId\":\"{conversationId}\"," +
            $"\"toolName\":\"{toolName}\",\"input\":{inputJson}}}");
        var result = await module.InvokeAsync(
            AppControl.PerformMethod, document.RootElement.Clone(), CancellationToken.None);
        return (Dictionary<string, object?>)result!;
    }

    private static void CheckContains(Dictionary<string, object?> result, string fragment, string label) =>
        Check(
            result.GetValueOrDefault("executionError") is string error &&
                error.Contains(fragment, StringComparison.Ordinal),
            label);

    private static void Check(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"App control assertion failed: {label}");
        }
    }

    private sealed class FakeHost : IAppControlHost
    {
        private readonly AppTarget _target = new(123, "notepad", 456);
        private readonly AppWindow _window = new(77, "running", new PixelRect(100, 200, 800, 600));

        public bool Alive { get; set; } = true;
        public bool Foreground { get; set; } = true;
        public int? ForegroundChecksRemaining { get; set; }
        public int PressCount { get; private set; }
        public string? TypedText { get; private set; }
        public (double X, double Y, string Button)? Click { get; private set; }

        public AppResolution ResolveRunning(string app) =>
            app.Equals("notepad", StringComparison.OrdinalIgnoreCase)
                ? new AppResolution(_target)
                : new AppResolution(null);

        public Task<AppResolution> LaunchAsync(
            string app, IReadOnlyList<string> arguments, CancellationToken cancellationToken) =>
            Task.FromResult(new AppResolution(null, $"App not found: {app}"));

        public bool IsAlive(AppTarget target) => Alive && target == _target;

        public Task<AppWindow> FocusAsync(AppTarget target, CancellationToken cancellationToken) =>
            Task.FromResult(_window);

        public AppWindow Inspect(AppTarget target) => _window;

        public string CapturePng(AppTarget target, AppWindow window) => "png";

        public bool IsForegroundOwner(AppTarget target, AppWindow window)
        {
            if (ForegroundChecksRemaining is { } remaining)
            {
                ForegroundChecksRemaining = remaining - 1;
                return remaining > 0;
            }
            return Foreground;
        }

        public Task PressAsync(
            AppTarget target, AppWindow window, IReadOnlyList<ushort> keys, int durationMs,
            CancellationToken cancellationToken)
        {
            PressCount += 1;
            return Task.CompletedTask;
        }

        public void TypeText(AppTarget target, AppWindow window, string text) => TypedText = text;

        public Task ClickAsync(
            AppTarget target, AppWindow window, double x, double y, string button, bool doubleClick,
            CancellationToken cancellationToken)
        {
            Click = (x, y, button);
            return Task.CompletedTask;
        }

        public Task DragAsync(
            AppTarget target, AppWindow window,
            double fromX, double fromY, double toX, double toY, string button,
            CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
