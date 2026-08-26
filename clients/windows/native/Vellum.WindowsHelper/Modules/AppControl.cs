using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

// One step of an app-control sequence, decoded from snake_case wire keys.
public sealed record AppControlSequenceStep(
    string Key, IReadOnlyList<string>? Modifiers, int? DurationMs, int? GapMs);

// Wire input for appControl.perform: `{ "tool": "<variant>", ...fields }`,
// the same discriminated union the macOS helper decodes.
public sealed record AppControlInput(
    string Tool,
    string? App = null,
    IReadOnlyList<string>? Args = null,
    int? SettleMs = null,
    string? Key = null,
    IReadOnlyList<string>? Modifiers = null,
    int? DurationMs = null,
    IReadOnlyList<string>? Keys = null,
    IReadOnlyList<AppControlSequenceStep>? Steps = null,
    string? Text = null,
    double? X = null,
    double? Y = null,
    string? Button = null,
    bool DoubleClick = false,
    double? FromX = null,
    double? FromY = null,
    double? ToX = null,
    double? ToY = null)
{
    public static AppControlInput Parse(JsonElement? input, string? toolName = null)
    {
        var tool = JsonInput.GetString(input, "tool") ?? ToolFromName(
            JsonInput.GetString(input, "toolName") ?? toolName
                ?? throw new ArgumentException("app control input requires tool"));

        string Require(string key) => JsonInput.GetString(input, key)
            ?? throw new ArgumentException($"app control {tool} requires {key}");
        double RequireDouble(string key) => JsonInput.GetDouble(input, key)
            ?? throw new ArgumentException($"app control {tool} requires {key}");

        return tool switch
        {
            "start" => new(tool, App: Require("app"), Args: GetStrings(input, "args")),
            "observe" => new(tool, App: Require("app"), SettleMs: JsonInput.GetInt(input, "settle_ms")),
            "press" => new(
                tool, App: Require("app"), Key: Require("key"),
                Modifiers: GetStrings(input, "modifiers"),
                DurationMs: JsonInput.GetInt(input, "duration_ms")),
            "combo" => new(
                tool, App: Require("app"),
                Keys: GetStrings(input, "keys")
                    ?? throw new ArgumentException("app control combo requires keys"),
                DurationMs: JsonInput.GetInt(input, "duration_ms")),
            "sequence" => new(tool, App: Require("app"), Steps: ParseSteps(input)),
            "type" => new(tool, App: Require("app"), Text: Require("text")),
            "click" => new(
                tool, App: Require("app"), X: RequireDouble("x"), Y: RequireDouble("y"),
                Button: JsonInput.GetString(input, "button"),
                DoubleClick: GetBool(input, "double")),
            "drag" => new(
                tool, App: Require("app"),
                FromX: RequireDouble("from_x"), FromY: RequireDouble("from_y"),
                ToX: RequireDouble("to_x"), ToY: RequireDouble("to_y"),
                Button: JsonInput.GetString(input, "button")),
            "stop" => new(tool),
            _ => throw new ArgumentException($"Unknown app control tool: {tool}"),
        };
    }

    // Derives the variant from a daemon tool name such as app_control_press.
    private static string ToolFromName(string name) =>
        name.StartsWith("app_control_", StringComparison.Ordinal)
            ? name["app_control_".Length..]
            : name;

    private static IReadOnlyList<AppControlSequenceStep> ParseSteps(JsonElement? input)
    {
        if (input is not { ValueKind: JsonValueKind.Object } value ||
            !value.TryGetProperty("steps", out var steps) ||
            steps.ValueKind != JsonValueKind.Array)
        {
            throw new ArgumentException("app control sequence requires steps");
        }
        var parsed = new List<AppControlSequenceStep>();
        foreach (var step in steps.EnumerateArray())
        {
            parsed.Add(new AppControlSequenceStep(
                JsonInput.GetString(step, "key")
                    ?? throw new ArgumentException("sequence step requires key"),
                GetStrings(step, "modifiers"),
                JsonInput.GetInt(step, "duration_ms"),
                JsonInput.GetInt(step, "gap_ms")));
        }
        return parsed;
    }

    private static IReadOnlyList<string>? GetStrings(JsonElement? element, string name)
    {
        if (element is not { ValueKind: JsonValueKind.Object } value ||
            !value.TryGetProperty(name, out var array) ||
            array.ValueKind != JsonValueKind.Array)
        {
            return null;
        }
        return array.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString()!)
            .ToList();
    }

    private static bool GetBool(JsonElement? element, string name) =>
        element is { ValueKind: JsonValueKind.Object } value &&
        value.TryGetProperty(name, out var property) &&
        property.ValueKind == JsonValueKind.True;
}

// A resolved target: the process plus its top-level window when it has one.
public sealed record AppTarget(int ProcessId, string Name, nint Window);

// Window capture result. `State` classifies the window (running / minimized /
// missing); `CaptureError` is an orthogonal signal that the screenshot failed.
public sealed record AppWindowCaptureResult(
    string State, string? PngBase64, PixelRect? Bounds, string? CaptureError);

// Registers appControl.perform: per-window raw input and capture for a named
// app, mirroring the macOS helper's AppControlExecutor.
public sealed class AppControl : IRpcModule
{
    public const string PerformMethod = "appControl.perform";

    public IReadOnlyCollection<string> Methods { get; } = [PerformMethod];

    public async ValueTask<object?> InvokeAsync(
        string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        if (parameters is not { ValueKind: JsonValueKind.Object } request)
        {
            throw new ArgumentException("appControl.perform requires params");
        }
        var requestId = JsonInput.GetString(request, "requestId")
            ?? throw new ArgumentException("appControl.perform requires requestId");
        // The daemon sends `{requestId, conversationId, toolName, input:{...}}`
        // where `input` carries the `tool` discriminator.
        var inputElement = request.TryGetProperty("input", out var value) &&
            value.ValueKind == JsonValueKind.Object
            ? value
            : request;
        AppControlInput input;
        try
        {
            input = AppControlInput.Parse(inputElement, JsonInput.GetString(request, "toolName"));
        }
        catch (ArgumentException error)
        {
            return AppControlExecutor.Result(requestId, "missing", executionError: error.Message);
        }
        return await AppControlExecutor.PerformAsync(requestId, input, cancellationToken);
    }
}

public static class AppControlExecutor
{
    private const int DefaultObserveSettleMs = 200;
    private const int SequenceDefaultGapMs = 30;
    private const int SequenceDefaultDurationMs = 50;
    private const int DefaultPressDurationMs = 50;
    private const int StartWindowTimeoutMs = 3000;
    private const int DragSteps = 10;

    // Never throws: every failure is reported as a result payload.
    public static async Task<Dictionary<string, object?>> PerformAsync(
        string requestId, AppControlInput input, CancellationToken cancellationToken)
    {
        try
        {
            return input.Tool switch
            {
                "start" => await StartAsync(requestId, input.App!, input.Args, cancellationToken),
                "observe" => await ObserveAsync(requestId, input.App!, input.SettleMs, cancellationToken),
                "press" => await WithTargetAsync(requestId, input.App!, target =>
                    PressAsync(target, input.Key!, input.Modifiers, input.DurationMs ?? DefaultPressDurationMs, cancellationToken), cancellationToken),
                "combo" => await WithTargetAsync(requestId, input.App!, target =>
                    ComboAsync(target, input.Keys!, input.DurationMs ?? DefaultPressDurationMs, cancellationToken), cancellationToken),
                "sequence" => await WithTargetAsync(requestId, input.App!, target =>
                    SequenceAsync(target, input.Steps!, cancellationToken), cancellationToken),
                "type" => await WithTargetAsync(requestId, input.App!, target =>
                    TypeAsync(target, input.Text!), cancellationToken),
                "click" => await ClickAsync(requestId, input, cancellationToken),
                "drag" => await DragAsync(requestId, input, cancellationToken),
                "stop" => Result(requestId, "running", executionResult: "session stopped"),
                _ => Result(requestId, "missing", executionError: $"Unknown app control tool: {input.Tool}"),
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            return Result(requestId, "running", executionError: error.Message);
        }
    }

    public static Dictionary<string, object?> Result(
        string requestId, string state, string? pngBase64 = null, PixelRect? bounds = null,
        string? executionResult = null, string? executionError = null)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["requestId"] = requestId,
            ["state"] = state,
        };
        if (pngBase64 is not null)
        {
            result["pngBase64"] = pngBase64;
        }
        if (bounds is not null)
        {
            result["windowBounds"] = new
            {
                x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height,
            };
        }
        if (executionResult is not null)
        {
            result["executionResult"] = executionResult;
        }
        if (executionError is not null)
        {
            result["executionError"] = executionError;
        }
        return result;
    }

    // Window-relative point to virtual-desktop pixels.
    public static (double X, double Y) ToScreen(PixelRect bounds, double x, double y) =>
        (bounds.X + x, bounds.Y + y);

    // `steps` evenly spaced points strictly between `from` and `to`.
    public static IReadOnlyList<(double X, double Y)> Interpolate(
        (double X, double Y) from, (double X, double Y) to, int steps)
    {
        var points = new List<(double, double)>();
        for (var i = 1; i <= steps; i++)
        {
            var t = i / (double)(steps + 1);
            points.Add((from.X + (to.X - from.X) * t, from.Y + (to.Y - from.Y) * t));
        }
        return points;
    }

    // Process-name form of an app identifier: a bare name or path with any
    // ".exe" suffix removed, as Process.GetProcessesByName expects.
    public static string ToProcessName(string app)
    {
        var name = Path.GetFileName(app.Trim());
        return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? name[..^4]
            : name;
    }

    // "hwnd:1234" or a bare integer targets a window handle directly.
    public static bool TryParseWindowHandle(string app, out nint handle)
    {
        var text = app.Trim();
        if (text.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase))
        {
            text = text["hwnd:".Length..];
        }
        else if (!text.All(char.IsAsciiDigit))
        {
            handle = 0;
            return false;
        }
        if (long.TryParse(text, out var parsed) && parsed > 0)
        {
            handle = (nint)parsed;
            return true;
        }
        handle = 0;
        return false;
    }

    private static async Task<Dictionary<string, object?>> StartAsync(
        string requestId, string app, IReadOnlyList<string>? args, CancellationToken cancellationToken)
    {
        if (AppWindows.Resolve(app) is { } running)
        {
            // Already running: restore and bring forward so start reports a
            // visible window, which the daemon needs to promote the session.
            await AppWindows.BringToFrontAsync(running.Window, cancellationToken);
            var capture = await CaptureWhenReadyAsync(() => AppWindows.Resolve(app), cancellationToken);
            return Result(
                requestId, capture.State, capture.PngBase64, capture.Bounds,
                $"started: {running.Name} (already running, pid={running.ProcessId})");
        }

        int? launchedPid;
        try
        {
            var startInfo = new ProcessStartInfo(app) { UseShellExecute = true };
            foreach (var arg in args ?? [])
            {
                startInfo.ArgumentList.Add(arg);
            }
            using var launched = Process.Start(startInfo);
            launchedPid = launched?.Id;
        }
        catch (Win32Exception error) when (error.NativeErrorCode is 2 or 3)
        {
            return Result(requestId, "missing", executionError: $"App not found: {app}");
        }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException)
        {
            return Result(requestId, "missing", executionError: $"Failed to launch {app}: {error.Message}");
        }

        // ShellExecute may hand off to a launcher, so poll by the launched pid
        // first and fall back to resolving the name once a real window shows.
        AppTarget? ResolveLaunched() =>
            (launchedPid is { } pid ? AppWindows.ResolveByPid(pid) : null) ?? AppWindows.Resolve(app);
        var launchedCapture = await CaptureWhenReadyAsync(ResolveLaunched, cancellationToken);
        var target = ResolveLaunched();
        return target is null
            ? Result(requestId, "missing", executionError: $"Failed to launch {app}: no process found")
            : Result(
                requestId, launchedCapture.State, launchedCapture.PngBase64, launchedCapture.Bounds,
                $"started: {target.Name} (launched, pid={target.ProcessId})");
    }

    private static async Task<AppWindowCaptureResult> CaptureWhenReadyAsync(
        Func<AppTarget?> resolve, CancellationToken cancellationToken)
    {
        var deadline = Environment.TickCount64 + StartWindowTimeoutMs;
        var capture = AppWindows.Capture(resolve());
        while (capture.State != "running" && Environment.TickCount64 < deadline)
        {
            await Task.Delay(100, cancellationToken);
            capture = AppWindows.Capture(resolve());
        }
        return capture;
    }

    private static async Task<Dictionary<string, object?>> ObserveAsync(
        string requestId, string app, int? settleMs, CancellationToken cancellationToken)
    {
        if (AppWindows.Resolve(app) is not { } target)
        {
            return Result(requestId, "missing", executionError: $"App not running: {app}");
        }
        var settle = Math.Max(0, settleMs ?? DefaultObserveSettleMs);
        if (settle > 0)
        {
            await Task.Delay(settle, cancellationToken);
        }
        var capture = AppWindows.Capture(target);
        return Result(
            requestId, capture.State, capture.PngBase64, capture.Bounds,
            $"observed: {target.Name} (pid={target.ProcessId})", capture.CaptureError);
    }

    // Resolve, focus, then run an input action that reports its own summary.
    private static async Task<Dictionary<string, object?>> WithTargetAsync(
        string requestId, string app, Func<AppTarget, Task<string>> action,
        CancellationToken cancellationToken)
    {
        if (AppWindows.Resolve(app) is not { } target)
        {
            return Result(requestId, "missing", executionError: $"App not running: {app}");
        }
        await AppWindows.BringToFrontAsync(target.Window, cancellationToken);
        try
        {
            return Result(requestId, "running", executionResult: await action(target));
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException)
        {
            return Result(requestId, "running", executionError: error.Message);
        }
    }

    private static async Task<string> PressAsync(
        AppTarget target, string key, IReadOnlyList<string>? modifiers, int durationMs,
        CancellationToken cancellationToken)
    {
        await NativeInput.PressChordAsync(
            ResolveChord(modifiers, key), durationMs, cancellationToken);
        return $"pressed {key} (pid={target.ProcessId})";
    }

    private static async Task<string> ComboAsync(
        AppTarget target, IReadOnlyList<string> keys, int durationMs, CancellationToken cancellationToken)
    {
        // Modifier tokens are pressed first so they apply to every other key.
        var modifiers = new List<ushort>();
        var codes = new List<ushort>();
        foreach (var key in keys)
        {
            if (KeyPlanner.TryResolveModifier(key, out var modifier))
            {
                modifiers.Add(modifier);
            }
            else
            {
                codes.Add(KeyPlanner.ResolveKey(key));
            }
        }
        await NativeInput.PressChordAsync([.. modifiers, .. codes], durationMs, cancellationToken);
        return $"combo {string.Join('+', keys)} (pid={target.ProcessId})";
    }

    private static async Task<string> SequenceAsync(
        AppTarget target, IReadOnlyList<AppControlSequenceStep> steps, CancellationToken cancellationToken)
    {
        if (steps.Count == 0)
        {
            throw new ArgumentException("sequence requires at least one step");
        }
        for (var index = 0; index < steps.Count; index++)
        {
            var step = steps[index];
            try
            {
                await NativeInput.PressChordAsync(
                    ResolveChord(step.Modifiers, step.Key),
                    step.DurationMs ?? SequenceDefaultDurationMs,
                    cancellationToken);
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException)
            {
                throw new InvalidOperationException(
                    $"step {index} (key={step.Key}) failed: {error.Message}");
            }
            var gap = step.GapMs ?? SequenceDefaultGapMs;
            if (index < steps.Count - 1 && gap > 0)
            {
                await Task.Delay(gap, cancellationToken);
            }
        }
        return $"sequence: {steps.Count} step(s) (pid={target.ProcessId})";
    }

    private static Task<string> TypeAsync(AppTarget target, string text)
    {
        NativeInput.TypeText(text);
        return Task.FromResult($"typed {text.Length} char(s) (pid={target.ProcessId})");
    }

    // Unknown modifier names are ignored, matching the macOS helper.
    private static ushort[] ResolveChord(IReadOnlyList<string>? modifiers, string key)
    {
        var codes = new List<ushort>();
        foreach (var modifier in modifiers ?? [])
        {
            if (KeyPlanner.TryResolveModifier(modifier, out var vk))
            {
                codes.Add(vk);
            }
        }
        codes.Add(KeyPlanner.ResolveKey(key));
        return [.. codes];
    }

    private static async Task<Dictionary<string, object?>> ClickAsync(
        string requestId, AppControlInput input, CancellationToken cancellationToken)
    {
        var (target, capture, failure) = await PrepareMouseAsync(requestId, input.App!, cancellationToken);
        if (failure is not null)
        {
            return failure;
        }
        var bounds = capture!.Bounds!;
        var (x, y) = ToScreen(bounds, input.X!.Value, input.Y!.Value);
        var button = ParseButton(input.Button);
        try
        {
            NativeInput.MoveTo(x, y);
            var presses = input.DoubleClick ? 2 : 1;
            for (var i = 0; i < presses; i++)
            {
                NativeInput.Button(button, down: true);
                try
                {
                    if (i < presses - 1)
                    {
                        await Task.Delay(30, cancellationToken);
                    }
                }
                finally
                {
                    NativeInput.Button(button, down: false);
                }
            }
            return Result(
                requestId, "running", capture.PngBase64, bounds,
                $"clicked at ({input.X}, {input.Y}) (pid={target!.ProcessId})");
        }
        catch (InvalidOperationException error)
        {
            return Result(requestId, "running", capture.PngBase64, bounds, executionError: error.Message);
        }
    }

    private static async Task<Dictionary<string, object?>> DragAsync(
        string requestId, AppControlInput input, CancellationToken cancellationToken)
    {
        var (target, capture, failure) = await PrepareMouseAsync(requestId, input.App!, cancellationToken);
        if (failure is not null)
        {
            return failure;
        }
        var bounds = capture!.Bounds!;
        var from = ToScreen(bounds, input.FromX!.Value, input.FromY!.Value);
        var to = ToScreen(bounds, input.ToX!.Value, input.ToY!.Value);
        var button = ParseButton(input.Button);
        try
        {
            NativeInput.MoveTo(from.X, from.Y);
            NativeInput.Button(button, down: true);
            try
            {
                foreach (var point in Interpolate(from, to, DragSteps))
                {
                    NativeInput.MoveTo(point.X, point.Y);
                    await Task.Delay(10, cancellationToken);
                }
                NativeInput.MoveTo(to.X, to.Y);
            }
            finally
            {
                NativeInput.Button(button, down: false);
            }
            return Result(
                requestId, "running", capture.PngBase64, bounds,
                $"dragged ({input.FromX}, {input.FromY}) -> ({input.ToX}, {input.ToY}) (pid={target!.ProcessId})");
        }
        catch (InvalidOperationException error)
        {
            return Result(requestId, "running", capture.PngBase64, bounds, executionError: error.Message);
        }
    }

    // Shared click/drag prelude: resolve, focus, and capture bounds. Bounds
    // are required to translate window-relative coordinates, so a missing
    // window is always an error; a missing PNG alone is not.
    private static async Task<(AppTarget? Target, AppWindowCaptureResult? Capture, Dictionary<string, object?>? Failure)>
        PrepareMouseAsync(string requestId, string app, CancellationToken cancellationToken)
    {
        if (AppWindows.Resolve(app) is not { } target)
        {
            return (null, null, Result(requestId, "missing", executionError: $"App not running: {app}"));
        }
        await AppWindows.BringToFrontAsync(target.Window, cancellationToken);
        var capture = AppWindows.Capture(target);
        if (capture.State != "running" || capture.Bounds is null)
        {
            return (target, capture, Result(
                requestId, capture.State, capture.PngBase64, capture.Bounds,
                executionError: capture.CaptureError ?? $"Window not visible (state={capture.State})"));
        }
        return (target, capture, null);
    }

    private static string ParseButton(string? button)
    {
        var normalized = button?.ToLowerInvariant();
        return normalized is "right" or "middle" ? normalized : "left";
    }
}

// Process and top-level window resolution plus per-window capture.
internal static class AppWindows
{
    private const int ActivateWaitDeadlineMs = 100;
    private const int ActivatePollIntervalMs = 5;
    private const int ActivatePostFlipSettleMs = 30;
    private const int SwRestore = 9;
    private const int GwOwner = 4;
    private const int DwmaExtendedFrameBounds = 9;
    private const uint PwRenderFullContent = 0x2;

    // Bundle-ID style targets have no Windows equivalent; the identifier is
    // tried as a window handle, then a process name, then a main window title.
    public static AppTarget? Resolve(string app)
    {
        if (AppControlExecutor.TryParseWindowHandle(app, out var handle) &&
            WindowNativeMethods.IsWindow(handle))
        {
            _ = WindowNativeMethods.GetWindowThreadProcessId(handle, out var pid);
            return new AppTarget((int)pid, NameOf((int)pid) ?? app, handle);
        }

        var byName = Process.GetProcessesByName(AppControlExecutor.ToProcessName(app));
        try
        {
            if (byName.Length > 0)
            {
                var chosen = byName
                    .Select(process => (process, window: FindMainWindow(process.Id)))
                    .OrderByDescending(pair => pair.window != 0)
                    .First();
                var name = byName.Length > 1
                    ? $"{chosen.process.ProcessName} [{byName.Length} matches]"
                    : chosen.process.ProcessName;
                return new AppTarget(chosen.process.Id, name, chosen.window);
            }
        }
        finally
        {
            foreach (var process in byName)
            {
                process.Dispose();
            }
        }

        return ResolveByTitle(app);
    }

    public static AppTarget? ResolveByPid(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited)
            {
                return null;
            }
            return new AppTarget(pid, process.ProcessName, FindMainWindow(pid));
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return null;
        }
    }

    private static AppTarget? ResolveByTitle(string app)
    {
        AppTarget? contains = null;
        AppTarget? exact = null;
        WindowNativeMethods.EnumWindows((window, _) =>
        {
            if (!IsCandidateWindow(window))
            {
                return true;
            }
            var title = TitleOf(window);
            if (title.Length == 0)
            {
                return true;
            }
            _ = WindowNativeMethods.GetWindowThreadProcessId(window, out var pid);
            if (string.Equals(title, app, StringComparison.OrdinalIgnoreCase))
            {
                exact ??= new AppTarget((int)pid, NameOf((int)pid) ?? title, window);
                return false;
            }
            if (title.Contains(app, StringComparison.OrdinalIgnoreCase))
            {
                contains ??= new AppTarget((int)pid, NameOf((int)pid) ?? title, window);
            }
            return true;
        }, 0);
        return exact ?? contains;
    }

    private static string? NameOf(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return null;
        }
    }

    private static string TitleOf(nint window)
    {
        var length = WindowNativeMethods.GetWindowTextLength(window);
        if (length <= 0)
        {
            return string.Empty;
        }
        var buffer = new char[length + 1];
        var copied = WindowNativeMethods.GetWindowText(window, buffer, buffer.Length);
        return new string(buffer, 0, Math.Max(0, copied));
    }

    // The first visible, unowned top-level window for the pid, preferring the
    // foreground window when it belongs to the same process.
    public static nint FindMainWindow(int pid)
    {
        var foreground = WindowNativeMethods.GetForegroundWindow();
        if (foreground != 0)
        {
            _ = WindowNativeMethods.GetWindowThreadProcessId(foreground, out var foregroundPid);
            if ((int)foregroundPid == pid && IsCandidateWindow(foreground))
            {
                return foreground;
            }
        }
        nint found = 0;
        WindowNativeMethods.EnumWindows((window, _) =>
        {
            _ = WindowNativeMethods.GetWindowThreadProcessId(window, out var owner);
            if ((int)owner != pid || !IsCandidateWindow(window))
            {
                return true;
            }
            found = window;
            return false;
        }, 0);
        return found;
    }

    private static bool IsCandidateWindow(nint window) =>
        WindowNativeMethods.IsWindowVisible(window) &&
        WindowNativeMethods.GetWindow(window, GwOwner) == 0;

    // SendInput targets the foreground window, so the app must be frontmost
    // before any synthesized input. Best effort: proceeds after the deadline.
    public static async Task BringToFrontAsync(nint window, CancellationToken cancellationToken)
    {
        if (window == 0)
        {
            return;
        }
        if (WindowNativeMethods.IsIconic(window))
        {
            _ = WindowNativeMethods.ShowWindow(window, SwRestore);
        }
        if (WindowNativeMethods.GetForegroundWindow() != window)
        {
            // A background process may not steal focus; attaching to the
            // current foreground thread's input queue lifts that restriction.
            var foreground = WindowNativeMethods.GetForegroundWindow();
            var foregroundThread = foreground == 0
                ? 0u
                : WindowNativeMethods.GetWindowThreadProcessId(foreground, out _);
            var current = WindowNativeMethods.GetCurrentThreadId();
            var attached = foregroundThread != 0 && foregroundThread != current &&
                WindowNativeMethods.AttachThreadInput(current, foregroundThread, true);
            try
            {
                _ = WindowNativeMethods.BringWindowToTop(window);
                _ = WindowNativeMethods.SetForegroundWindow(window);
            }
            finally
            {
                if (attached)
                {
                    _ = WindowNativeMethods.AttachThreadInput(current, foregroundThread, false);
                }
            }
        }
        var deadline = Environment.TickCount64 + ActivateWaitDeadlineMs;
        while (WindowNativeMethods.GetForegroundWindow() != window && Environment.TickCount64 < deadline)
        {
            await Task.Delay(ActivatePollIntervalMs, cancellationToken);
        }
        // Keyboard focus routing can lag the foreground flip by a frame or two.
        await Task.Delay(ActivatePostFlipSettleMs, cancellationToken);
    }

    public static AppWindowCaptureResult Capture(AppTarget? target)
    {
        if (target is null)
        {
            return new AppWindowCaptureResult("missing", null, null, null);
        }
        var window = target.Window != 0 && WindowNativeMethods.IsWindow(target.Window)
            ? target.Window
            : FindMainWindow(target.ProcessId);
        if (window == 0 || WindowNativeMethods.IsIconic(window) || !WindowNativeMethods.IsWindowVisible(window))
        {
            return new AppWindowCaptureResult("minimized", null, null, null);
        }
        ProcessDpi.EnsureAwareness();
        var bounds = BoundsOf(window);
        if (bounds is null || bounds.Width <= 0 || bounds.Height <= 0)
        {
            return new AppWindowCaptureResult("minimized", null, null, null);
        }
        try
        {
            return new AppWindowCaptureResult("running", CapturePng(window, bounds), bounds, null);
        }
        catch (Exception ex) when (ex is ExternalException or InvalidOperationException or ArgumentException)
        {
            return new AppWindowCaptureResult(
                "running", null, bounds,
                $"Window capture failed: {ex.Message} (the window may be elevated or protected)");
        }
    }

    // Physical-pixel bounds of the window as it appears on screen; the DWM
    // frame bounds exclude the invisible resize borders GetWindowRect includes.
    private static PixelRect? BoundsOf(nint window)
    {
        if (WindowNativeMethods.DwmGetWindowAttribute(
                window, DwmaExtendedFrameBounds, out var frame, Marshal.SizeOf<WindowNativeMethods.NativeRect>()) != 0 &&
            !WindowNativeMethods.GetWindowRect(window, out frame))
        {
            return null;
        }
        return new PixelRect(frame.Left, frame.Top, frame.Right - frame.Left, frame.Bottom - frame.Top);
    }

    // PrintWindow renders the window's own surface even when partly covered;
    // it is aligned to the DWM frame bounds so the PNG matches windowBounds.
    // Falls back to a screen copy for windows that refuse to render.
    private static string CapturePng(nint window, PixelRect bounds)
    {
        using var bitmap = new Bitmap(bounds.Width, bounds.Height);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var rendered = false;
            if (WindowNativeMethods.GetWindowRect(window, out var full))
            {
                // PrintWindow draws from the GetWindowRect origin; shift so the
                // DWM-visible frame lands at (0, 0).
                using var surface = new Bitmap(
                    Math.Max(1, full.Right - full.Left), Math.Max(1, full.Bottom - full.Top));
                using (var surfaceGraphics = Graphics.FromImage(surface))
                {
                    var hdc = surfaceGraphics.GetHdc();
                    try
                    {
                        rendered = WindowNativeMethods.PrintWindow(window, hdc, PwRenderFullContent);
                    }
                    finally
                    {
                        surfaceGraphics.ReleaseHdc(hdc);
                    }
                }
                if (rendered)
                {
                    graphics.DrawImage(surface, full.Left - bounds.X, full.Top - bounds.Y);
                }
            }
            if (!rendered)
            {
                graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, new Size(bounds.Width, bounds.Height));
            }
        }
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return Convert.ToBase64String(stream.ToArray());
    }
}

internal static class WindowNativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    internal delegate bool EnumWindowsProc(nint window, nint lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindow(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsIconic(nint window);

    [DllImport("user32.dll")]
    internal static extern nint GetWindow(nint window, int command);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextLength(nint window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(nint window, [Out] char[] text, int maxCount);

    [DllImport("user32.dll")]
    internal static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool BringWindowToTop(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ShowWindow(nint window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AttachThreadInput(uint attach, uint attachTo, [MarshalAs(UnmanagedType.Bool)] bool attaching);

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetWindowRect(nint window, out NativeRect rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PrintWindow(nint window, nint hdc, uint flags);

    [DllImport("dwmapi.dll")]
    internal static extern int DwmGetWindowAttribute(nint window, int attribute, out NativeRect value, int size);
}
