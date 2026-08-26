using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class AppControlTests
{
    public static async Task RunAsync()
    {
        // The tool discriminator wins; otherwise it derives from the tool name.
        Check(Parse("{\"tool\":\"observe\",\"app\":\"notepad\",\"settle_ms\":0}") is
            { Tool: "observe", App: "notepad", SettleMs: 0 }, "observe parse");
        Check(Parse("{\"app\":\"notepad\",\"key\":\"a\"}", "app_control_press") is
            { Tool: "press", Key: "a", Modifiers: null }, "tool from toolName");
        Check(Parse("{\"tool\":\"click\",\"app\":\"x\",\"x\":10,\"y\":20,\"double\":true,\"button\":\"right\"}") is
            { X: 10, Y: 20, DoubleClick: true, Button: "right" }, "click parse");
        Check(Parse("{\"tool\":\"drag\",\"app\":\"x\",\"from_x\":1,\"from_y\":2,\"to_x\":3,\"to_y\":4}") is
            { FromX: 1, FromY: 2, ToX: 3, ToY: 4 }, "drag parse");
        Check(Parse("{\"tool\":\"stop\"}").Tool == "stop", "stop needs no app");

        var sequence = Parse(
            "{\"tool\":\"sequence\",\"app\":\"x\",\"steps\":[{\"key\":\"right\",\"gap_ms\":5},{\"key\":\"a\",\"modifiers\":[\"ctrl\"],\"duration_ms\":10}]}");
        Check(sequence.Steps is [{ Key: "right", GapMs: 5 }, { Key: "a", Modifiers: ["ctrl"], DurationMs: 10 }],
            "sequence steps");

        // Missing required fields and unknown tools throw the daemon's messages.
        CheckThrows(() => Parse("{\"tool\":\"press\",\"app\":\"x\"}"), "press requires key");
        CheckThrows(() => Parse("{\"tool\":\"combo\",\"app\":\"x\"}"), "combo requires keys");
        CheckThrows(() => Parse("{\"tool\":\"sequence\",\"app\":\"x\",\"steps\":[{}]}"), "step requires key");
        CheckThrows(() => Parse("{\"tool\":\"teleport\",\"app\":\"x\"}"), "unknown tool");
        CheckThrows(() => Parse("{\"app\":\"x\"}"), "tool required");

        // Window-relative coordinates translate through the window origin.
        Check(AppControlExecutor.ToScreen(new PixelRect(100, 50, 800, 600), 10, 20) == (110, 70), "to screen");
        var points = AppControlExecutor.Interpolate((0, 0), (110, 220), 10);
        Check(points.Count == 10 && Near(points[0], (10, 20)) && Near(points[9], (100, 200)), "interpolate");
        Check(AppControlExecutor.Interpolate((0, 0), (1, 1), 0).Count == 0, "interpolate none");

        // Target identifiers: process names shed paths and .exe; handles parse.
        Check(AppControlExecutor.ToProcessName("Notepad.EXE") == "Notepad", "exe suffix");
        Check(AppControlExecutor.ToProcessName(@"C:\Windows\notepad.exe") == "notepad", "path");
        Check(AppControlExecutor.TryParseWindowHandle("hwnd:1234", out var handle) && handle == 1234, "hwnd prefix");
        Check(AppControlExecutor.TryParseWindowHandle("5678", out handle) && handle == 5678, "bare handle");
        Check(!AppControlExecutor.TryParseWindowHandle("notepad", out _), "name is not a handle");

        // Module: bad input is reported as a result payload, not an RPC error.
        var module = new AppControl();
        var invalid = await Invoke(module, "{\"requestId\":\"r1\",\"input\":{\"tool\":\"press\",\"app\":\"x\"}}");
        Check(invalid["state"] is "missing" && invalid["executionError"] is "app control press requires key",
            "invalid input payload");

        // stop never touches the target app.
        var stopped = await Invoke(module, "{\"requestId\":\"r2\",\"toolName\":\"app_control_stop\",\"input\":{\"tool\":\"stop\"}}");
        Check(stopped["state"] is "running" && stopped["executionResult"] is "session stopped", "stop");

        // A process that does not exist reports missing with the macOS message.
        var absent = await Invoke(
            module, "{\"requestId\":\"r3\",\"input\":{\"tool\":\"observe\",\"app\":\"vellum-no-such-process-7f3a\"}}");
        Check(absent["state"] is "missing" && absent["executionError"] is "App not running: vellum-no-such-process-7f3a",
            "absent process");

        Console.WriteLine("App control tests passed");
    }

    private static AppControlInput Parse(string json, string? toolName = null)
    {
        using var document = JsonDocument.Parse(json);
        return AppControlInput.Parse(document.RootElement, toolName);
    }

    private static async Task<Dictionary<string, object?>> Invoke(AppControl module, string paramsJson)
    {
        using var document = JsonDocument.Parse(paramsJson);
        var result = await module.InvokeAsync(AppControl.PerformMethod, document.RootElement, CancellationToken.None);
        return (Dictionary<string, object?>)result!;
    }

    private static bool Near((double X, double Y) actual, (double X, double Y) expected) =>
        Math.Abs(actual.X - expected.X) < 1e-9 && Math.Abs(actual.Y - expected.Y) < 1e-9;

    private static void Check(bool condition, string name)
    {
        if (!condition)
        {
            throw new Exception($"App control assertion failed: {name}");
        }
    }

    private static void CheckThrows(Action action, string name)
    {
        try
        {
            action();
        }
        catch (ArgumentException)
        {
            return;
        }
        throw new Exception($"App control assertion failed: {name} did not throw");
    }
}
