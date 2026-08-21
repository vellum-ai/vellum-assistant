using Microsoft.Win32;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

public sealed record AppTarget(int ProcessId, string Name, long StartTimeUtcTicks);

public sealed record AppWindow(nint Handle, string State, PixelRect? Bounds);

public sealed record AppResolution(AppTarget? Target, string? Error = null);

public interface IAppControlHost
{
    AppResolution ResolveRunning(string app);
    Task<AppResolution> LaunchAsync(
        string app, IReadOnlyList<string> arguments, CancellationToken cancellationToken);
    bool IsAlive(AppTarget target);
    Task<AppWindow> FocusAsync(AppTarget target, CancellationToken cancellationToken);
    AppWindow Inspect(AppTarget target);
    string CapturePng(AppTarget target, AppWindow window);
    bool IsForegroundOwner(AppTarget target, AppWindow window);
    Task PressAsync(
        AppTarget target, AppWindow window, IReadOnlyList<ushort> keys, int durationMs,
        CancellationToken cancellationToken);
    void TypeText(AppTarget target, AppWindow window, string text);
    Task ClickAsync(
        AppTarget target, AppWindow window, double x, double y, string button, bool doubleClick,
        CancellationToken cancellationToken);
    Task DragAsync(
        AppTarget target, AppWindow window,
        double fromX, double fromY, double toX, double toY, string button,
        CancellationToken cancellationToken);
}

public sealed record AppControlSession(string App, AppTarget Target, DateTimeOffset TouchedAt);

public sealed class AppControlSessionStore(
    TimeSpan? ttl = null,
    Func<DateTimeOffset>? clock = null)
{
    private readonly TimeSpan _ttl = ttl ?? TimeSpan.FromMinutes(10);
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly Dictionary<string, AppControlSession> _sessions = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public void Set(string conversationId, string app, AppTarget target)
    {
        lock (_gate)
        {
            EvictExpired();
            if (_sessions.Keys.Any(id => id != conversationId))
            {
                throw new InvalidOperationException(
                    "Another conversation owns the native app-control session");
            }
            _sessions[conversationId] = new AppControlSession(app, target, _clock());
        }
    }

    public bool IsAvailable(string conversationId)
    {
        lock (_gate)
        {
            EvictExpired();
            return _sessions.Count == 0 || _sessions.ContainsKey(conversationId);
        }
    }

    public AppControlSession? Get(string conversationId, string app)
    {
        lock (_gate)
        {
            EvictExpired();
            if (!_sessions.TryGetValue(conversationId, out var session) ||
                !string.Equals(session.App, app, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
            var touched = session with { TouchedAt = _clock() };
            _sessions[conversationId] = touched;
            return touched;
        }
    }

    public void Clear(string conversationId)
    {
        lock (_gate)
        {
            _ = _sessions.Remove(conversationId);
        }
    }

    private void EvictExpired()
    {
        var cutoff = _clock() - _ttl;
        foreach (var id in _sessions
            .Where(entry => entry.Value.TouchedAt <= cutoff)
            .Select(entry => entry.Key)
            .ToList())
        {
            _sessions.Remove(id);
        }
    }
}

public sealed class AppControl : IRpcModule
{
    public const string PerformMethod = "appControl.perform";
    private const int DefaultSettleMs = 200;
    private const int DefaultDurationMs = 50;
    private const int DefaultGapMs = 30;
    private const int MaxSequenceSteps = 100;
    private const int MaxSequenceDurationMs = 30_000;
    private const int MaxTextLength = 100_000;

    private readonly IAppControlHost _host;
    private readonly AppControlSessionStore _sessions;

    public AppControl()
        : this(new WindowsAppControlHost(), new AppControlSessionStore())
    {
    }

    public AppControl(IAppControlHost host, AppControlSessionStore? sessions = null)
    {
        _host = host;
        _sessions = sessions ?? new AppControlSessionStore();
    }

    public IReadOnlyCollection<string> Methods { get; } = [PerformMethod];

    public async ValueTask<object?> InvokeAsync(
        string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        if (parameters is not { ValueKind: JsonValueKind.Object } request ||
            !request.TryGetProperty("input", out var input) ||
            input.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("appControl.perform requires input");
        }
        var requestId = JsonInput.GetString(request, "requestId") ?? "";
        var conversationId = JsonInput.GetString(request, "conversationId")
            ?? throw new ArgumentException("appControl.perform requires conversationId");
        var tool = JsonInput.GetString(input, "tool") ?? ToolFromName(JsonInput.GetString(request, "toolName"));
        if (string.IsNullOrWhiteSpace(tool))
        {
            throw new ArgumentException("appControl.perform requires tool");
        }

        try
        {
            return await PerformAsync(requestId, conversationId, tool, input, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException)
        {
            return Result(requestId, "missing", error: error.Message);
        }
    }

    private async Task<Dictionary<string, object?>> PerformAsync(
        string requestId, string conversationId, string tool, JsonElement input,
        CancellationToken cancellationToken)
    {
        if (tool == "stop")
        {
            _sessions.Clear(conversationId);
            return Result(requestId, "running", execution: "session stopped");
        }

        var app = RequiredString(input, "app", tool);
        if (app.Length > 1_024)
        {
            return Result(requestId, "missing", error: "app identifier exceeds 1024 characters");
        }
        if (tool == "start")
        {
            return await StartAsync(requestId, conversationId, app, input, cancellationToken);
        }

        var session = _sessions.Get(conversationId, app);
        if (session is null)
        {
            return Result(
                requestId,
                "missing",
                error: "No native app-control session is active for this conversation and app");
        }
        if (!_host.IsAlive(session.Target))
        {
            _sessions.Clear(conversationId);
            return Result(requestId, "missing", error: $"App not running: {app}");
        }

        try
        {
            return tool switch
            {
                "observe" => await ObserveAsync(requestId, session.Target, input, cancellationToken),
                "press" => await PressAsync(requestId, session.Target, input, cancellationToken),
                "combo" => await ComboAsync(requestId, session.Target, input, cancellationToken),
                "sequence" => await SequenceAsync(requestId, session.Target, input, cancellationToken),
                "type" => await TypeAsync(requestId, session.Target, input, cancellationToken),
                "click" => await ClickAsync(requestId, session.Target, input, cancellationToken),
                "drag" => await DragAsync(requestId, session.Target, input, cancellationToken),
                _ => Result(requestId, "running", error: $"Unknown app control tool: {tool}"),
            };
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException)
        {
            return Result(requestId, "running", error: error.Message);
        }
    }

    private async Task<Dictionary<string, object?>> StartAsync(
        string requestId, string conversationId, string app, JsonElement input,
        CancellationToken cancellationToken)
    {
        if (!_sessions.IsAvailable(conversationId))
        {
            return Result(
                requestId,
                "missing",
                error: "Another conversation owns the native app-control session");
        }
        var resolution = _host.ResolveRunning(app);
        var launched = false;
        if (resolution.Target is null && resolution.Error is null)
        {
            var arguments = ReadStringArray(input, "args", 64);
            resolution = await _host.LaunchAsync(app, arguments, cancellationToken);
            launched = resolution.Target is not null;
        }
        if (resolution.Target is not { } target)
        {
            return Result(requestId, "missing", error: resolution.Error ?? $"App not found: {app}");
        }

        var window = await _host.FocusAsync(target, cancellationToken);
        if (window.State != "running")
        {
            return WindowResult(requestId, window, error: $"Window not visible (state={window.State})");
        }
        if (!_host.IsForegroundOwner(target, window))
        {
            return Result(
                requestId,
                "minimized",
                error: "The target window could not acquire foreground focus");
        }
        _sessions.Set(conversationId, app, target);
        return CaptureResult(
            requestId,
            target,
            window,
            $"started: {target.Name} ({(launched ? "launched" : "already running")}, pid={target.ProcessId})");
    }

    private async Task<Dictionary<string, object?>> ObserveAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        var settleMs = Math.Clamp(JsonInput.GetInt(input, "settle_ms") ?? DefaultSettleMs, 0, 5_000);
        if (settleMs > 0)
        {
            await Task.Delay(settleMs, cancellationToken);
        }
        var window = await _host.FocusAsync(target, cancellationToken);
        if (window.State != "running")
        {
            return WindowResult(requestId, window, error: $"Window not visible (state={window.State})");
        }
        return CaptureResult(requestId, target, window, $"observed: {target.Name} (pid={target.ProcessId})");
    }

    private async Task<Dictionary<string, object?>> PressAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        var key = RequiredString(input, "key", "press");
        var keys = ReadStringArray(input, "modifiers", 8)
            .Append(key)
            .Select(KeyPlanner.ResolveKey)
            .ToArray();
        return await WithForegroundAsync(requestId, target, async window =>
        {
            await _host.PressAsync(target, window, keys, Duration(input), cancellationToken);
            return WindowResult(requestId, window, execution: $"pressed {key} (pid={target.ProcessId})");
        }, cancellationToken);
    }

    private async Task<Dictionary<string, object?>> ComboAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        var names = ReadStringArray(input, "keys", 16);
        if (names.Count == 0)
        {
            return Result(requestId, "running", error: "combo requires at least one key");
        }
        var keys = names.Select(KeyPlanner.ResolveKey).ToArray();
        return await WithForegroundAsync(requestId, target, async window =>
        {
            await _host.PressAsync(target, window, keys, Duration(input), cancellationToken);
            return WindowResult(
                requestId, window, execution: $"combo {string.Join('+', names)} (pid={target.ProcessId})");
        }, cancellationToken);
    }

    private async Task<Dictionary<string, object?>> SequenceAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        if (!input.TryGetProperty("steps", out var steps) || steps.ValueKind != JsonValueKind.Array)
        {
            return Result(requestId, "running", error: "sequence requires steps");
        }
        if (steps.GetArrayLength() is 0 or > MaxSequenceSteps)
        {
            return Result(requestId, "running", error: $"sequence requires 1-{MaxSequenceSteps} steps");
        }

        var plan = new List<(ushort[] Keys, int DurationMs, int GapMs)>();
        var totalDurationMs = 0;
        foreach (var step in steps.EnumerateArray())
        {
            var key = RequiredString(step, "key", "sequence");
            var keys = ReadStringArray(step, "modifiers", 8)
                .Append(key)
                .Select(KeyPlanner.ResolveKey)
                .ToArray();
            var durationMs = Math.Clamp(
                JsonInput.GetInt(step, "duration_ms") ?? DefaultDurationMs, 0, 5_000);
            var gapMs = Math.Clamp(
                JsonInput.GetInt(step, "gap_ms") ?? DefaultGapMs, 0, 5_000);
            totalDurationMs += durationMs + gapMs;
            plan.Add((keys, durationMs, gapMs));
        }
        if (totalDurationMs > MaxSequenceDurationMs)
        {
            return Result(
                requestId,
                "running",
                error: $"sequence duration exceeds {MaxSequenceDurationMs}ms");
        }

        var window = await _host.FocusAsync(target, cancellationToken);
        if (window.State != "running")
        {
            return WindowResult(requestId, window, error: $"Window not visible (state={window.State})");
        }
        var index = 0;
        foreach (var step in plan)
        {
            if (!_host.IsForegroundOwner(target, window))
            {
                return WindowResult(
                    requestId, window, error: $"Target lost foreground ownership before sequence step {index}");
            }
            await _host.PressAsync(
                target,
                window,
                step.Keys,
                step.DurationMs,
                cancellationToken);
            index += 1;
            if (index < plan.Count)
            {
                if (step.GapMs > 0)
                {
                    await Task.Delay(step.GapMs, cancellationToken);
                }
            }
        }
        return WindowResult(
            requestId, window, execution: $"sequence: {index} step(s) (pid={target.ProcessId})");
    }

    private async Task<Dictionary<string, object?>> TypeAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        var text = RequiredString(input, "text", "type");
        if (text.Length > MaxTextLength)
        {
            return Result(requestId, "running", error: $"text exceeds {MaxTextLength} characters");
        }
        return await WithForegroundAsync(requestId, target, window =>
        {
            _host.TypeText(target, window, text);
            return Task.FromResult(WindowResult(
                requestId, window, execution: $"typed {text.Length} char(s) (pid={target.ProcessId})"));
        }, cancellationToken);
    }

    private async Task<Dictionary<string, object?>> ClickAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        return await WithForegroundAsync(requestId, target, async window =>
        {
            var bounds = window.Bounds!;
            var x = Coordinate(input, "x", bounds.Width);
            var y = Coordinate(input, "y", bounds.Height);
            var button = Button(input);
            await _host.ClickAsync(
                target,
                window,
                bounds.X + x,
                bounds.Y + y,
                button,
                input.TryGetProperty("double", out var doubleValue) && doubleValue.ValueKind == JsonValueKind.True,
                cancellationToken);
            return WindowResult(
                requestId, window, execution: $"clicked at ({x}, {y}) (pid={target.ProcessId})");
        }, cancellationToken);
    }

    private async Task<Dictionary<string, object?>> DragAsync(
        string requestId, AppTarget target, JsonElement input, CancellationToken cancellationToken)
    {
        return await WithForegroundAsync(requestId, target, async window =>
        {
            var bounds = window.Bounds!;
            var fromX = Coordinate(input, "from_x", bounds.Width);
            var fromY = Coordinate(input, "from_y", bounds.Height);
            var toX = Coordinate(input, "to_x", bounds.Width);
            var toY = Coordinate(input, "to_y", bounds.Height);
            await _host.DragAsync(
                target,
                window,
                bounds.X + fromX,
                bounds.Y + fromY,
                bounds.X + toX,
                bounds.Y + toY,
                Button(input),
                cancellationToken);
            return WindowResult(
                requestId,
                window,
                execution: $"dragged ({fromX}, {fromY}) -> ({toX}, {toY}) (pid={target.ProcessId})");
        }, cancellationToken);
    }

    private async Task<Dictionary<string, object?>> WithForegroundAsync(
        string requestId,
        AppTarget target,
        Func<AppWindow, Task<Dictionary<string, object?>>> action,
        CancellationToken cancellationToken)
    {
        var window = await _host.FocusAsync(target, cancellationToken);
        if (window.State != "running")
        {
            return WindowResult(requestId, window, error: $"Window not visible (state={window.State})");
        }
        if (!_host.IsForegroundOwner(target, window))
        {
            return WindowResult(
                requestId, window, error: "Target window does not own foreground focus; input was not sent");
        }
        try
        {
            return await action(window);
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException)
        {
            return WindowResult(requestId, window, error: error.Message);
        }
    }

    private Dictionary<string, object?> CaptureResult(
        string requestId, AppTarget target, AppWindow window, string execution)
    {
        try
        {
            return WindowResult(
                requestId, window, png: _host.CapturePng(target, window), execution: execution);
        }
        catch (InvalidOperationException error)
        {
            return WindowResult(requestId, window, execution: execution, error: error.Message);
        }
    }

    private static int Duration(JsonElement input) =>
        Math.Clamp(JsonInput.GetInt(input, "duration_ms") ?? DefaultDurationMs, 0, 5_000);

    private static double Coordinate(JsonElement input, string name, int extent)
    {
        var value = JsonInput.GetDouble(input, name)
            ?? throw new ArgumentException($"app control requires {name}");
        if (!double.IsFinite(value) || value < 0 || value >= extent)
        {
            throw new ArgumentException($"{name} is outside the target window");
        }
        return value;
    }

    private static string Button(JsonElement input)
    {
        var button = JsonInput.GetString(input, "button") ?? "left";
        return button is "left" or "right" or "middle"
            ? button
            : throw new ArgumentException($"Unsupported mouse button: {button}");
    }

    private static string RequiredString(JsonElement input, string name, string tool) =>
        JsonInput.GetString(input, name) is { Length: > 0 } value
            ? value
            : throw new ArgumentException($"app control {tool} requires {name}");

    private static IReadOnlyList<string> ReadStringArray(JsonElement input, string name, int limit)
    {
        if (!input.TryGetProperty(name, out var array) || array.ValueKind == JsonValueKind.Null)
        {
            return [];
        }
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > limit)
        {
            throw new ArgumentException($"app control {name} must contain at most {limit} strings");
        }
        var values = new List<string>();
        foreach (var item in array.EnumerateArray())
        {
            var value = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
            if (string.IsNullOrEmpty(value))
            {
                throw new ArgumentException($"app control {name} must contain only non-empty strings");
            }
            if (value.Length > 32_767)
            {
                throw new ArgumentException($"app control {name} contains an oversized string");
            }
            values.Add(value);
        }
        return values;
    }

    private static string? ToolFromName(string? toolName) =>
        toolName?.StartsWith("app_control_", StringComparison.Ordinal) == true
            ? toolName["app_control_".Length..]
            : toolName;

    private static Dictionary<string, object?> Result(
        string requestId, string state, string? execution = null, string? error = null) =>
        WindowResult(requestId, new AppWindow(0, state, null), execution: execution, error: error);

    private static Dictionary<string, object?> WindowResult(
        string requestId,
        AppWindow window,
        string? png = null,
        string? execution = null,
        string? error = null)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["requestId"] = requestId,
            ["state"] = window.State,
        };
        if (png is not null)
        {
            result["pngBase64"] = png;
        }
        if (window.Bounds is not null)
        {
            result["windowBounds"] = new Dictionary<string, object?>
            {
                ["x"] = window.Bounds.X,
                ["y"] = window.Bounds.Y,
                ["width"] = window.Bounds.Width,
                ["height"] = window.Bounds.Height,
            };
        }
        if (execution is not null)
        {
            result["executionResult"] = execution;
        }
        if (error is not null)
        {
            result["executionError"] = error;
        }
        return result;
    }
}

public sealed class WindowsAppControlHost : IAppControlHost
{
    private const int FocusTimeoutMs = 750;
    private const int LaunchTimeoutMs = 5_000;

    public AppResolution ResolveRunning(string app)
    {
        var candidates = FindProcesses(app)
            .Select(ToTarget)
            .Where(target => target is not null)
            .Cast<AppTarget>()
            .ToList();
        if (candidates.Count == 0)
        {
            return new AppResolution(null);
        }
        if (candidates.Count == 1)
        {
            return new AppResolution(candidates[0]);
        }
        var foreground = AppControlNativeMethods.GetForegroundWindow();
        _ = AppControlNativeMethods.GetWindowThreadProcessId(foreground, out var foregroundPid);
        var foregroundTarget = candidates.SingleOrDefault(target => target.ProcessId == foregroundPid);
        return foregroundTarget is not null
            ? new AppResolution(foregroundTarget)
            : new AppResolution(null, $"Multiple running processes match {app}; focus the intended window and retry");
    }

    public async Task<AppResolution> LaunchAsync(
        string app, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var executable = ResolveExecutable(app);
        if (executable is null)
        {
            return new AppResolution(null, $"App not found: {app}");
        }
        try
        {
            var startInfo = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(executable) ?? Environment.CurrentDirectory,
            };
            foreach (var argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }
            _ = Process.Start(startInfo);
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return new AppResolution(null, $"Failed to launch {app}: {error.Message}");
        }

        var processName = Path.GetFileNameWithoutExtension(executable);
        var deadline = Environment.TickCount64 + LaunchTimeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var resolution = ResolveRunning(processName);
            if (resolution.Target is not null)
            {
                return resolution;
            }
            await Task.Delay(100, cancellationToken);
        }
        return new AppResolution(null, $"{app} launched but no target window became available");
    }

    public bool IsAlive(AppTarget target)
    {
        try
        {
            using var process = Process.GetProcessById(target.ProcessId);
            return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == target.StartTimeUtcTicks;
        }
        catch (Exception error) when (error is
            ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    public async Task<AppWindow> FocusAsync(AppTarget target, CancellationToken cancellationToken)
    {
        var window = Inspect(target);
        if (window.State == "missing")
        {
            return window;
        }
        if (window.Handle == 0)
        {
            return window with { State = "minimized" };
        }
        if (AppControlNativeMethods.IsIconic(window.Handle))
        {
            _ = AppControlNativeMethods.ShowWindow(window.Handle, 9);
        }
        try
        {
            AutomationElement.FromHandle(window.Handle).SetFocus();
        }
        catch (Exception error) when (error is
            ElementNotAvailableException or UnauthorizedAccessException or COMException)
        {
        }
        _ = AppControlNativeMethods.SetForegroundWindow(window.Handle);
        var deadline = Environment.TickCount64 + FocusTimeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (IsForegroundOwner(target, window))
            {
                return Inspect(target);
            }
            await Task.Delay(15, cancellationToken);
        }
        return window with { State = "running" };
    }

    public AppWindow Inspect(AppTarget target)
    {
        ProcessDpi.EnsureAwareness();
        if (!IsAlive(target))
        {
            return new AppWindow(0, "missing", null);
        }
        var windows = EnumerateWindows(target.ProcessId);
        var foreground = AppControlNativeMethods.GetForegroundWindow();
        var visible = windows.Where(window => !AppControlNativeMethods.IsIconic(window)).ToList();
        var handle = visible.FirstOrDefault(window => window == foreground);
        if (handle == 0)
        {
            handle = visible
                .OrderByDescending(window => Area(ReadBounds(window)))
                .FirstOrDefault();
        }
        if (handle == 0)
        {
            return new AppWindow(0, "minimized", null);
        }
        return new AppWindow(handle, "running", ReadBounds(handle));
    }

    public string CapturePng(AppTarget target, AppWindow window)
    {
        if (!IsForegroundOwner(target, window) || window.Bounds is not { Width: > 0, Height: > 0 } bounds)
        {
            throw new InvalidOperationException("Target window does not own foreground focus; capture was blocked");
        }
        if (HasForeignOcclusion(target, window.Handle, bounds))
        {
            throw new InvalidOperationException("Another process overlaps the target window; capture was blocked");
        }
        try
        {
            return new GdiScreenCapture().CapturePixels(bounds).PngBase64;
        }
        catch (Exception error) when (error is ArgumentException or System.Runtime.InteropServices.ExternalException)
        {
            throw new InvalidOperationException("The target window could not be captured", error);
        }
    }

    public bool IsForegroundOwner(AppTarget target, AppWindow window)
    {
        if (window.Handle == 0 || AppControlNativeMethods.GetForegroundWindow() != window.Handle ||
            !OwnsWindow(target, window.Handle))
        {
            return false;
        }
        try
        {
            return AutomationElement.FromHandle(window.Handle).Current.ProcessId == target.ProcessId;
        }
        catch (Exception error) when (error is
            ElementNotAvailableException or UnauthorizedAccessException or COMException or InvalidOperationException)
        {
            return false;
        }
    }

    public Task PressAsync(
        AppTarget target, AppWindow window, IReadOnlyList<ushort> keys, int durationMs,
        CancellationToken cancellationToken)
    {
        EnsureForeground(target, window);
        return NativeInput.PressChordAsync(keys, durationMs, cancellationToken);
    }

    public void TypeText(AppTarget target, AppWindow window, string text)
    {
        EnsureForeground(target, window);
        NativeInput.TypeText(text);
    }

    public async Task ClickAsync(
        AppTarget target, AppWindow window, double x, double y, string button, bool doubleClick,
        CancellationToken cancellationToken)
    {
        EnsureForeground(target, window);
        EnsurePointOwner(target, x, y);
        NativeInput.MoveTo(x, y);
        for (var click = 0; click < (doubleClick ? 2 : 1); click++)
        {
            NativeInput.Button(button, down: true);
            try
            {
                await Task.Delay(25, cancellationToken);
            }
            finally
            {
                NativeInput.Button(button, down: false);
            }
            if (doubleClick && click == 0)
            {
                await Task.Delay(50, cancellationToken);
            }
        }
    }

    public async Task DragAsync(
        AppTarget target, AppWindow window,
        double fromX, double fromY, double toX, double toY, string button,
        CancellationToken cancellationToken)
    {
        EnsureForeground(target, window);
        EnsurePointOwner(target, fromX, fromY);
        EnsurePointOwner(target, toX, toY);
        NativeInput.MoveTo(fromX, fromY);
        NativeInput.Button(button, down: true);
        try
        {
            const int steps = 20;
            for (var step = 1; step <= steps; step++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var fraction = step / (double)steps;
                var x = fromX + (toX - fromX) * fraction;
                var y = fromY + (toY - fromY) * fraction;
                EnsureForeground(target, window);
                EnsurePointOwner(target, x, y);
                NativeInput.MoveTo(x, y);
                await Task.Delay(10, cancellationToken);
            }
        }
        finally
        {
            NativeInput.Button(button, down: false);
        }
    }

    private static void EnsureForeground(AppTarget target, AppWindow window)
    {
        if (AppControlNativeMethods.GetForegroundWindow() != window.Handle ||
            !WindowBelongsToProcess(window.Handle, target.ProcessId))
        {
            throw new InvalidOperationException("Target window lost foreground ownership; input was not sent");
        }
    }

    private static void EnsurePointOwner(AppTarget target, double x, double y)
    {
        var hit = AppControlNativeMethods.WindowFromPoint(
            new NativePoint((int)Math.Round(x), (int)Math.Round(y)));
        _ = AppControlNativeMethods.GetWindowThreadProcessId(hit, out var owner);
        if (hit == 0 || owner != target.ProcessId)
        {
            throw new InvalidOperationException(
                "A target coordinate is covered by another process; input was not sent");
        }
    }

    private static IReadOnlyList<Process> FindProcesses(string app)
    {
        var normalized = Path.GetFileNameWithoutExtension(app);
        var path = Path.IsPathRooted(app) ? Path.GetFullPath(app) : null;
        var matches = new List<Process>();
        foreach (var process in Process.GetProcesses())
        {
            var matched = false;
            try
            {
                if (path is not null)
                {
                    if (string.Equals(process.MainModule?.FileName, path, StringComparison.OrdinalIgnoreCase))
                    {
                        matches.Add(process);
                        matched = true;
                    }
                }
                else if (string.Equals(process.ProcessName, normalized, StringComparison.OrdinalIgnoreCase))
                {
                    matches.Add(process);
                    matched = true;
                }
            }
            catch (Exception error) when (error is
                InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
            if (!matched)
            {
                process.Dispose();
            }
        }
        return matches;
    }

    private static AppTarget? ToTarget(Process process)
    {
        using (process)
        {
            try
            {
                return process.HasExited || IsForbiddenProcess(process.Id)
                    ? null
                    : new AppTarget(
                        process.Id,
                        process.ProcessName,
                        process.StartTime.ToUniversalTime().Ticks);
            }
            catch (Exception error) when (error is
                InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                return null;
            }
        }
    }

    private static bool IsForbiddenProcess(int processId)
    {
        if (processId == Environment.ProcessId)
        {
            return true;
        }
        return int.TryParse(
            Environment.GetEnvironmentVariable(WindowsWindowTargetSource.HostProcessIdEnvironmentVariable),
            out var hostProcessId) && processId == hostProcessId;
    }

    private static string? ResolveExecutable(string app)
    {
        if (Path.IsPathRooted(app))
        {
            var path = Path.GetFullPath(app);
            return File.Exists(path) && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? path
                : null;
        }
        var fileName = app.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? app : $"{app}.exe";
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var key = root.OpenSubKey($@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{fileName}");
            if (key?.GetValue(null) is string registered && File.Exists(registered))
            {
                return Path.GetFullPath(registered);
            }
        }
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var candidate = Path.Combine(directory, fileName);
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }
        return null;
    }

    private static IReadOnlyList<nint> EnumerateWindows(int processId)
    {
        var windows = new List<nint>();
        _ = AppControlNativeMethods.EnumWindows((handle, _) =>
        {
            _ = AppControlNativeMethods.GetWindowThreadProcessId(handle, out var owner);
            if (owner == processId && AppControlNativeMethods.IsWindowVisible(handle) &&
                AppControlNativeMethods.GetWindow(handle, 4) == 0)
            {
                windows.Add(handle);
            }
            return true;
        }, 0);
        return windows;
    }

    private static bool OwnsWindow(AppTarget target, nint handle)
    {
        return WindowBelongsToProcess(handle, target.ProcessId) && IsTargetIdentity(target);
    }

    private static bool WindowBelongsToProcess(nint handle, int processId)
    {
        _ = AppControlNativeMethods.GetWindowThreadProcessId(handle, out var owner);
        return owner == processId && AppControlNativeMethods.IsWindow(handle);
    }

    private static bool IsTargetIdentity(AppTarget target)
    {
        try
        {
            using var process = Process.GetProcessById(target.ProcessId);
            return process.StartTime.ToUniversalTime().Ticks == target.StartTimeUtcTicks;
        }
        catch (Exception error) when (error is
            ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static PixelRect ReadBounds(nint handle)
    {
        NativeRect rect;
        var result = AppControlNativeMethods.DwmGetWindowRect(
            handle, 9, out rect, Marshal.SizeOf<NativeRect>());
        if (result != 0 && !AppControlNativeMethods.GetWindowRect(handle, out rect))
        {
            return new PixelRect(0, 0, 0, 0);
        }
        return new PixelRect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    private static long Area(PixelRect bounds) =>
        (long)Math.Max(0, bounds.Width) * Math.Max(0, bounds.Height);

    private static bool HasForeignOcclusion(AppTarget target, nint targetWindow, PixelRect bounds)
    {
        for (var window = AppControlNativeMethods.GetTopWindow(0);
            window != 0 && window != targetWindow;
            window = AppControlNativeMethods.GetWindow(window, 2))
        {
            _ = AppControlNativeMethods.GetWindowThreadProcessId(window, out var owner);
            if (owner == target.ProcessId || !AppControlNativeMethods.IsWindowVisible(window) ||
                AppControlNativeMethods.IsIconic(window) || IsCloaked(window))
            {
                continue;
            }
            var other = ReadBounds(window);
            if (Intersects(bounds, other))
            {
                return true;
            }
        }
        return false;
    }

    private static bool IsCloaked(nint window) =>
        AppControlNativeMethods.DwmGetCloaked(window, 14, out int cloaked, sizeof(int)) == 0 &&
        cloaked != 0;

    private static bool Intersects(PixelRect left, PixelRect right) =>
        left.X < right.X + right.Width && left.X + left.Width > right.X &&
        left.Y < right.Y + right.Height && left.Y + left.Height > right.Y;
}

[StructLayout(LayoutKind.Sequential)]
file struct NativeRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
file struct NativePoint(int x, int y)
{
    public int X = x;
    public int Y = y;
}

file static partial class AppControlNativeMethods
{
    internal delegate bool EnumWindowsCallback(nint window, nint parameter);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool EnumWindows(EnumWindowsCallback callback, nint parameter);

    [LibraryImport("user32.dll")]
    internal static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll")]
    internal static partial nint WindowFromPoint(NativePoint point);

    [LibraryImport("user32.dll")]
    internal static partial uint GetWindowThreadProcessId(nint window, out int processId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsWindow(nint window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsWindowVisible(nint window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsIconic(nint window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetForegroundWindow(nint window);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool ShowWindow(nint window, int command);

    [LibraryImport("user32.dll")]
    internal static partial nint GetTopWindow(nint window);

    [LibraryImport("user32.dll")]
    internal static partial nint GetWindow(nint window, uint command);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetWindowRect(nint window, out NativeRect rect);

    [LibraryImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    internal static partial int DwmGetWindowRect(
        nint window, int attribute, out NativeRect value, int size);

    [LibraryImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    internal static partial int DwmGetCloaked(
        nint window, int attribute, out int value, int size);
}
