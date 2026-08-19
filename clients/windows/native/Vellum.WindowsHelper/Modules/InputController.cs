using System.Runtime.InteropServices;
using System.Text.Json;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

// Maps portable key and chord names to Windows virtual-key codes. The macOS
// "cmd" modifier maps to Ctrl, its closest Windows equivalent.
public static class KeyPlanner
{
    private static readonly Dictionary<string, ushort> Modifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        ["cmd"] = 0x11, ["command"] = 0x11, ["ctrl"] = 0x11, ["control"] = 0x11,
        ["shift"] = 0x10, ["alt"] = 0x12, ["option"] = 0x12, ["win"] = 0x5B, ["meta"] = 0x5B,
    };

    private static readonly Dictionary<string, ushort> NamedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["enter"] = 0x0D, ["return"] = 0x0D, ["tab"] = 0x09, ["escape"] = 0x1B, ["esc"] = 0x1B,
        ["backspace"] = 0x08, ["delete"] = 0x2E, ["space"] = 0x20,
        ["up"] = 0x26, ["down"] = 0x28, ["left"] = 0x25, ["right"] = 0x27,
        ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["pagedown"] = 0x22,
    };

    // Parses a "ctrl+shift+t" style chord into press-ordered key codes.
    public static ushort[] ParseChord(string chord)
    {
        var parts = chord.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
        {
            throw new ArgumentException($"Unsupported key: {chord}");
        }
        var codes = new ushort[parts.Length];
        for (var i = 0; i < parts.Length - 1; i++)
        {
            codes[i] = Modifiers.TryGetValue(parts[i], out var modifier)
                ? modifier
                : throw new ArgumentException($"Unsupported modifier: {parts[i]}");
        }
        codes[^1] = ResolveKey(parts[^1]);
        return codes;
    }

    public static ushort ResolveKey(string key)
    {
        if (NamedKeys.TryGetValue(key, out var named))
        {
            return named;
        }
        if (Modifiers.TryGetValue(key, out var modifier))
        {
            return modifier;
        }
        if (key.Length == 1 && char.ToUpperInvariant(key[0]) is var upper &&
            upper is (>= 'A' and <= 'Z') or (>= '0' and <= '9'))
        {
            return (ushort)upper;
        }
        if (key.Length is 2 or 3 && key[0] is 'f' or 'F' &&
            int.TryParse(key.AsSpan(1), out var fn) && fn is >= 1 and <= 24)
        {
            return (ushort)(0x70 + fn - 1);
        }
        throw new ArgumentException($"Unsupported key: {key}");
    }

    // UTF-16 units for KEYEVENTF_UNICODE typing (surrogate pairs stay two
    // units); newlines become Enter presses, carriage returns are dropped.
    public static IEnumerable<(char Unit, bool IsReturn)> PlanText(string text) =>
        text.Where(unit => unit != '\r').Select(unit => (unit, unit == '\n'));

    // Wheel delta for one scroll: sign encodes direction, magnitude is wheel
    // detents (120 per notch) with the amount clamped to 1..10.
    public static (int Delta, bool Horizontal) PlanScroll(string direction, int amount)
    {
        var notches = Math.Clamp(amount, 1, 10) * 120;
        return direction.ToLowerInvariant() switch
        {
            "up" => (notches, false),
            "down" => (-notches, false),
            "left" => (-notches, true),
            "right" => (notches, true),
            _ => throw new ArgumentException($"Unsupported scroll direction: {direction}"),
        };
    }
}

// SendInput synthesis in physical virtual-desktop pixels. A rejected injection
// (for example toward an elevated window) throws so it is never reported as
// success.
internal static partial class NativeInput
{
    private const uint KeyUp = 0x0002;
    private const uint Extended = 0x0001;
    private const uint UnicodeFlag = 0x0004;
    private static readonly Dictionary<string, (uint Down, uint Up)> Buttons = new(StringComparer.OrdinalIgnoreCase)
    {
        ["left"] = (0x0002, 0x0004), ["right"] = (0x0008, 0x0010), ["middle"] = (0x0020, 0x0040),
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx, Dy;
        public uint MouseData, Flags, Time;
        public nint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Vk, Scan;
        public uint Flags, Time;
        public nint ExtraInfo;
    }

    [LibraryImport("user32.dll", SetLastError = true)]
    private static partial uint SendInput(uint count, Input[] inputs, int size);
    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);
    private static void Send(Input input)
    {
        if (SendInput(1, [input], Marshal.SizeOf<Input>()) != 1)
        {
            throw new InvalidOperationException(
                "Input injection was blocked (the foreground window may be elevated)");
        }
    }

    private static void Keyboard(ushort vk, ushort scan, uint flags) =>
        Send(new Input { Type = 1, Union = { Keyboard = new() { Vk = vk, Scan = scan, Flags = flags } } });
    private static void Mouse(int dx, int dy, uint mouseData, uint flags) =>
        Send(new Input { Union = { Mouse = new() { Dx = dx, Dy = dy, MouseData = mouseData, Flags = flags } } });

    public static void Key(ushort vk, bool down)
    {
        // Navigation and meta keys are extended-range and need the flag to land.
        var extended = vk is (>= 0x21 and <= 0x2E) or 0x5B or 0x5C ? Extended : 0;
        Keyboard(vk, 0, extended | (down ? 0 : KeyUp));
    }

    public static void Unicode(char unit, bool down) =>
        Keyboard(0, unit, UnicodeFlag | (down ? 0 : KeyUp));

    public static void MoveTo(double x, double y)
    {
        ProcessDpi.EnsureAwareness();
        var left = GetSystemMetrics(76);
        var top = GetSystemMetrics(77);
        var width = Math.Max(1, GetSystemMetrics(78));
        var height = Math.Max(1, GetSystemMetrics(79));
        Mouse(
            (int)Math.Round((x - left) * 65535 / width),
            (int)Math.Round((y - top) * 65535 / height),
            0,
            0x0001 | 0x8000 | 0x4000); // MOVE | ABSOLUTE | VIRTUALDESK
    }

    public static void Button(string button, bool down)
    {
        var pair = Buttons.TryGetValue(button, out var found) ? found : Buttons["left"];
        Mouse(0, 0, 0, down ? pair.Down : pair.Up);
    }

    public static void Wheel(int delta, bool horizontal) =>
        Mouse(0, 0, unchecked((uint)delta), horizontal ? 0x1000u : 0x0800u);

    // Presses codes in order, holds, then releases in reverse even on failure,
    // so no modifier is left logically held.
    public static async Task PressChordAsync(
        IReadOnlyList<ushort> codes, int holdMs, CancellationToken cancellationToken)
    {
        var pressed = new Stack<ushort>();
        try
        {
            foreach (var code in codes)
            {
                Key(code, down: true);
                pressed.Push(code);
            }
            await Task.Delay(Math.Clamp(holdMs, 0, 5_000), cancellationToken);
        }
        finally
        {
            while (pressed.Count > 0)
            {
                Key(pressed.Pop(), down: false);
            }
        }
    }

    public static void TypeText(string text)
    {
        foreach (var (unit, isReturn) in KeyPlanner.PlanText(text))
        {
            if (isReturn)
            {
                Key(0x0D, down: true);
                Key(0x0D, down: false);
            }
            else
            {
                Unicode(unit, down: true);
                Unicode(unit, down: false);
            }
        }
    }
}

// Registers cu.perform: the verified computer-use action cycle of map, verify,
// execute, settle, then observe, preserving the committed result shape.
public sealed class InputController : IRpcModule, IInputController
{
    private const int SettleDelayMs = 300;

    public string CapabilityId => "input-controller";

    public IReadOnlyCollection<string> Methods { get; } = ["cu.perform"];

    public async ValueTask<object?> InvokeAsync(
        string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        if (parameters is not { ValueKind: JsonValueKind.Object } request)
        {
            throw new ArgumentException("cu.perform requires params");
        }
        var toolName = JsonInput.GetString(request, "toolName")
            ?? throw new ArgumentException("cu.perform requires toolName");
        var input = request.TryGetProperty("input", out var value) && value.ValueKind == JsonValueKind.Object
            ? value
            : (JsonElement?)null;
        return await PerformAsync(
            JsonInput.GetString(request, "conversationId") ?? "",
            toolName, input,
            JsonInput.GetInt(request, "stepNumber") ?? 1,
            cancellationToken);
    }

    private static async Task<Dictionary<string, object?>> PerformAsync(
        string conversationId, string toolName, JsonElement? input, int stepNumber,
        CancellationToken cancellationToken)
    {
        var verifier = CuSessionStore.Touch(conversationId);
        var action = MapAction(toolName, input);
        Task<Dictionary<string, object?>> Finish(string? result, string? error, int settleMs = 0, bool note = true) =>
            BuildResultAsync(conversationId, stepNumber, settleMs, result, error, note, cancellationToken);

        if (action.Type is "observe")
        {
            return await Finish(null, null);
        }
        if (action.Type is "done" or "respond")
        {
            CuSessionStore.Clear(conversationId);
            return await Finish(null, null, note: false);
        }

        try
        {
            action = await ResolveElementCoordinatesAsync(
                action, ObservationSeams.CuSource, cancellationToken, conversationId);
        }
        catch (InvalidOperationException error)
        {
            return await Finish(null, error.Message);
        }

        if (action.Type is "click" or "double_click" or "right_click" &&
            (action.X is null || action.Y is null))
        {
            return await Finish(null, "Coordinates or a valid element_id are required");
        }

        var verdict = verifier.Verify(action);
        if (verdict.Verdict is not CuVerdict.Allowed)
        {
            var suffix = verdict.Verdict is CuVerdict.NeedsConfirmation
                ? " (confirmation not available in proxy mode)"
                : "";
            return await Finish(null, $"BLOCKED: {verdict.Reason}{suffix}");
        }

        try
        {
            return await Finish(await ExecuteAsync(action, cancellationToken), null, SettleDelayMs);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception err)
        {
            return await Finish(null, err.Message, SettleDelayMs);
        }
    }

    public static async Task<CuAction> ResolveElementCoordinatesAsync(
        CuAction action, ICuObservationSource? source, CancellationToken cancellationToken,
        string conversationId = "")
    {
        if (action.Type is not ("click" or "double_click" or "right_click" or "scroll"))
        {
            return action;
        }
        if (action is { X: double x, Y: double y })
        {
            if (source is null)
            {
                return action;
            }
            var screenPoint = await source.TranslateScreenPointAsync(
                conversationId, new CuPoint(x, y), cancellationToken);
            return action with { X = screenPoint.X, Y = screenPoint.Y };
        }
        if (action.ElementId is null)
        {
            return action;
        }
        if (source is null)
        {
            throw new InvalidOperationException(
                $"Element {action.ElementId} cannot be resolved because screen observation is unavailable");
        }
        var elementPoint = await source.ResolveElementCenterAsync(action.ElementId.Value, cancellationToken);
        if (elementPoint is null)
        {
            throw new InvalidOperationException(
                $"Element {action.ElementId} was not found in the current window");
        }
        return action with { X = elementPoint.X, Y = elementPoint.Y };
    }

    private static async Task<string> ExecuteAsync(CuAction action, CancellationToken cancellationToken)
    {
        switch (action.Type)
        {
            case "click" or "double_click" or "right_click":
            {
                var (x, y) = (action.X!.Value, action.Y!.Value);
                NativeInput.MoveTo(x, y);
                var button = action.Type == "right_click" ? "right" : "left";
                var presses = action.Type == "double_click" ? 2 : 1;
                for (var i = 0; i < presses; i++)
                {
                    // The release is guaranteed so a failure never leaves the
                    // physical button held down for the user.
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
                return $"{action.Type} at ({x}, {y})";
            }
            case "type_text":
                NativeInput.TypeText(action.Text ?? "");
                return $"typed {(action.Text ?? "").Length} char(s)";
            case "key":
                await NativeInput.PressChordAsync(KeyPlanner.ParseChord(action.Key ?? ""), 30, cancellationToken);
                return $"pressed {action.Key}";
            case "scroll":
            {
                if (action is { X: double x, Y: double y })
                {
                    NativeInput.MoveTo(x, y);
                }
                var (delta, horizontal) = KeyPlanner.PlanScroll(action.ScrollDirection ?? "down", action.ScrollAmount ?? 1);
                NativeInput.Wheel(delta, horizontal);
                return $"scrolled {action.ScrollDirection} by {action.ScrollAmount ?? 1}";
            }
            case "wait":
            {
                var waitMs = Math.Clamp(action.WaitDurationMs ?? 500, 0, 30_000);
                await Task.Delay(waitMs, cancellationToken);
                return $"waited {waitMs}ms";
            }
            case "run_applescript":
                // Structured unsupported result keeps the wire meaning intact.
                throw new NotSupportedException(
                    "run_applescript is not supported on Windows; use click, type, and key actions instead");
            case "drag" or "open_app":
                // Drag pointer paths and app launching are not implemented.
                throw new NotSupportedException($"{action.Type} is not yet available on Windows");
            default:
                throw new InvalidOperationException($"Unsupported action: {action.Type}");
        }
    }

    private static async Task<Dictionary<string, object?>> BuildResultAsync(
        string conversationId, int stepNumber, int settleMs,
        string? executionResult, string? executionError, bool includeUnavailableNote,
        CancellationToken cancellationToken)
    {
        Dictionary<string, object?> result;
        try
        {
            result = await ObservationSeams.SettleAndObserveCuAsync(conversationId, stepNumber, settleMs, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception err)
        {
            result = new(StringComparer.Ordinal);
            executionError ??= $"Observation failed: {err.Message}";
        }
        if (ObservationSeams.CuSource is null && includeUnavailableNote)
        {
            // Blind success is never reported: the daemon is told the screen state is unverified.
            const string note = "Screen observation is unavailable until the Windows observation module is installed.";
            executionError = executionError is null ? note : $"{executionError}; {note}";
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

    // Maps a daemon tool name plus its input onto a single verified action.
    public static CuAction MapAction(string toolName, JsonElement? input)
    {
        var name = toolName.StartsWith("computer_use_", StringComparison.Ordinal)
            ? toolName["computer_use_".Length..]
            : toolName.StartsWith("cu_", StringComparison.Ordinal) ? toolName["cu_".Length..] : toolName;
        // Screenshot requests are observation-only; unknown tools keep their own
        // name so execution reports them as unsupported instead of silently
        // ending the session the way a `done` mapping would.
        var type = name switch
        {
            "screenshot" => "observe",
            "press_key" => "key",
            _ => name,
        };
        var clickType = JsonInput.GetString(input, "click_type");
        if (type == "click" && clickType is "double" or "right")
        {
            type = clickType == "double" ? "double_click" : "right_click";
        }
        return new CuAction(
            type,
            X: JsonInput.GetDouble(input, "x"),
            Y: JsonInput.GetDouble(input, "y"),
            ElementId: JsonInput.GetLong(input, "element_id"),
            Text: JsonInput.GetString(input, "text"),
            Key: JsonInput.GetString(input, "key"),
            ScrollDirection: JsonInput.GetString(input, "direction") ?? JsonInput.GetString(input, "scroll_direction"),
            ScrollAmount: JsonInput.GetInt(input, "amount") ?? JsonInput.GetInt(input, "scroll_amount"),
            WaitDurationMs: JsonInput.GetInt(input, "duration_ms") ?? JsonInput.GetInt(input, "duration"),
            AppName: JsonInput.GetString(input, "app_name") ?? JsonInput.GetString(input, "appName"),
            Script: JsonInput.GetString(input, "script"));
    }
}

// Tolerant JSON field readers for helper module params.
public static class JsonInput
{
    public static string? GetString(JsonElement? element, string name) =>
        element is { ValueKind: JsonValueKind.Object } value &&
        value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    public static double? GetDouble(JsonElement? element, string name) =>
        element is { ValueKind: JsonValueKind.Object } value &&
        value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Number
            ? property.GetDouble()
            : null;

    public static int? GetInt(JsonElement? element, string name) =>
        GetDouble(element, name) is double parsed ? (int)parsed : null;

    public static long? GetLong(JsonElement? element, string name) =>
        element is { ValueKind: JsonValueKind.Object } value &&
        value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Number &&
        property.TryGetInt64(out var parsed)
            ? parsed
            : null;
}
