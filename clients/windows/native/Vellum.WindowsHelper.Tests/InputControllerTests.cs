using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class InputControllerTests
{
    public static async Task RunAsync()
    {
        // Chord parsing maps the macOS cmd modifier to Ctrl; unknowns throw.
        Check(KeyPlanner.ParseChord("cmd+c") is [0x11, 0x43], "cmd+c chord");
        Check(KeyPlanner.ResolveKey("F12") == 0x7B, "function key");
        CheckThrows(() => KeyPlanner.ParseChord("hyper+x"), "unknown modifier");
        CheckThrows(() => KeyPlanner.ResolveKey("nosuchkey"), "unknown key");

        // Unicode planning keeps surrogate pairs and maps newlines to Enter.
        var plan = KeyPlanner.PlanText("aé\r\n\U0001D11E").ToList();
        Check(plan.Count == 5 && plan[2].IsReturn && !plan[3].IsReturn, "text plan");

        // Scroll planning clamps the amount and encodes direction by sign.
        Check(KeyPlanner.PlanScroll("up", 3) == (360, false), "scroll up");
        Check(KeyPlanner.PlanScroll("left", 99) == (-1200, true), "scroll clamp");
        CheckThrows(() => KeyPlanner.PlanScroll("sideways", 1), "scroll direction");

        // Verifier: near-identical clicks trip loop detection.
        var loops = new ActionVerifier();
        var click = new CuAction("click", X: 10, Y: 10);
        Check(loops.Verify(click).Verdict == CuVerdict.Allowed, "first click");
        Check(loops.Verify(click with { X = 12 }).Verdict == CuVerdict.Allowed, "second click");
        Check(loops.Verify(click).Verdict == CuVerdict.Blocked, "click loop");

        // Verifier: step limit.
        var limited = new ActionVerifier(maxSteps: 1);
        Check(limited.Verify(new CuAction("key", Key: "tab")).Verdict == CuVerdict.Allowed, "under limit");
        Check(limited.Verify(new CuAction("scroll")).Verdict == CuVerdict.Blocked, "over limit");

        // Verifier: destructive combos and Enter after typing need confirmation.
        var confirm = new ActionVerifier();
        Check(
            confirm.Verify(new CuAction("key", Key: "alt+f4")).Verdict == CuVerdict.NeedsConfirmation,
            "destructive combo");
        Check(confirm.Verify(new CuAction("type_text", Text: "hi")).Verdict == CuVerdict.Allowed, "typing");
        Check(
            confirm.Verify(new CuAction("key", Key: "enter")).Verdict == CuVerdict.NeedsConfirmation,
            "enter after typing");

        // Verifier: destructive chords are canonicalized the way chords are parsed,
        // so spacing and casing cannot bypass the confirmation gate.
        Check(
            new ActionVerifier().Verify(new CuAction("key", Key: "ALT + F4")).Verdict
                == CuVerdict.NeedsConfirmation,
            "destructive combo spacing");

        // click_type selects the click flavor for the unified click tool, and
        // screenshot requests are observation-only.
        using var doubleClick = JsonDocument.Parse("{\"click_type\":\"double\"}");
        using var rightClick = JsonDocument.Parse("{\"click_type\":\"right\"}");
        Check(
            InputController.MapAction("computer_use_click", doubleClick.RootElement).Type == "double_click",
            "click_type double");
        Check(
            InputController.MapAction("computer_use_click", rightClick.RootElement).Type == "right_click",
            "click_type right");
        Check(InputController.MapAction("computer_use_click", null).Type == "click", "click default");
        using var elementClick = JsonDocument.Parse("{\"element_id\":9007199254740991}");
        Check(
            InputController.MapAction("computer_use_click", elementClick.RootElement).ElementId == 9007199254740991,
            "click element id");
        Check(InputController.MapAction("computer_use_screenshot", null).Type == "observe", "screenshot observes");
        Check(InputController.MapAction("computer_use_press_key", null).Type == "key", "press_key");

        // Drag carries a destination by coordinates or element id.
        using var dragInput = JsonDocument.Parse("{\"element_id\":1,\"to_x\":50,\"to_y\":60}");
        var drag = InputController.MapAction("computer_use_drag", dragInput.RootElement);
        Check(drag.Type == "drag" && drag.ElementId == 1 && drag.ToX == 50 && drag.ToY == 60, "drag mapping");

        // App names resolve through aliases and Start Menu shortcut stems.
        Check(AppLauncher.Resolve("vscode") == "Visual Studio Code", "app alias");
        var apps = new[]
        {
            new AppLauncher.AppEntry("Google Chrome", "chrome.lnk"),
            new AppLauncher.AppEntry("Slack Beta", "slack-beta.lnk"),
            new AppLauncher.AppEntry("Slack", "slack.lnk"),
            new AppLauncher.AppEntry("Visual Studio Code", "code.lnk"),
            new AppLauncher.AppEntry("Visual Studio Installer", "vsi.lnk"),
        };
        Check(AppLauncher.FindMatch(apps, "chrome", "Google Chrome") == "chrome.lnk", "app alias match");
        Check(AppLauncher.FindMatch(apps, "slack", "slack") == "slack.lnk", "app exact beats prefix");
        Check(AppLauncher.FindMatch(apps, "goog", "goog") == "chrome.lnk", "app unique prefix");
        Check(AppLauncher.FindMatch(apps, "zoom", "zoom") is null, "app missing");
        try
        {
            AppLauncher.FindMatch(apps, "Visual Studio", "Visual Studio");
            throw new Exception("Ambiguous prefix was accepted");
        }
        catch (InvalidOperationException err)
        {
            Check(err.Message.Contains("Visual Studio Installer", StringComparison.Ordinal), "app ambiguous prefix");
        }

        var module = new InputController();

        // An unrecognized tool reports an unsupported action instead of ending
        // the session as if the agent had completed its work.
        CheckContains(
            await InvokeAsync(module, "conv-unknown", "computer_use_teleport", "{}"),
            "Unsupported action", "unknown tool unsupported");

        // The script action reports a structured unsupported result.
        CheckContains(
            await InvokeAsync(module, "conv-script", "computer_use_run_applescript", "{\"script\":\"x\"}"),
            "not supported on Windows", "script unsupported");

        // An unknown element fails before any input is synthesized.
        ObservationSeams.CuSource = new FakeObservationSource();
        CheckContains(
            await InvokeAsync(module, "conv-element", "computer_use_click", "{\"element_id\":3}"),
            "was not found", "unknown element");

        // Drag resolves both endpoints; a missing destination fails before input.
        var dragResolved = await InputController.ResolveElementCoordinatesAsync(
            new CuAction("drag", X: 1, Y: 2, ToElementId: 7),
            new FakeObservationSource(new CuPoint(40, 60)),
            CancellationToken.None);
        Check(dragResolved.ToX == 40 && dragResolved.ToY == 60, "drag destination resolves");
        CheckContains(
            await InvokeAsync(module, "conv-drag", "computer_use_drag", "{\"x\":1,\"y\":2}"),
            "Destination coordinates", "drag needs destination");

        var resolved = await InputController.ResolveElementCoordinatesAsync(
            new CuAction("click", ElementId: 7),
            new FakeObservationSource(new CuPoint(40, 60)),
            CancellationToken.None);
        Check(resolved.X == 40 && resolved.Y == 60, "element center resolves");

        var translated = await InputController.ResolveElementCoordinatesAsync(
            new CuAction("click", X: 20, Y: 30),
            new FakeObservationSource(screenOffset: new CuPoint(-1920, -200)),
            CancellationToken.None,
            "conv-secondary");
        Check(translated.X == -1900 && translated.Y == -170,
            "screen coordinates include the captured display origin");

        // observe without an observation source flags that state is unverified.
        ObservationSeams.CuSource = null;
        CheckContains(
            await InvokeAsync(module, "conv-observe", "computer_use_observe", "{}"),
            "observation is unavailable", "observe unavailable");

        // respond ends the session without an error.
        Check(
            !(await InvokeAsync(module, "conv-respond", "computer_use_respond", "{\"answer\":\"d\"}"))
                .ContainsKey("executionError"),
            "respond has no error");

        Console.WriteLine("InputController tests passed");
    }

    private sealed class FakeObservationSource(
        CuPoint? point = null, CuPoint? screenOffset = null) : ICuObservationSource
    {
        public Task<IReadOnlyDictionary<string, object?>> ObserveAsync(
            string conversationId, int stepNumber, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyDictionary<string, object?>>(new Dictionary<string, object?>());

        public Task<CuPoint?> ResolveElementCenterAsync(
            long elementId, CancellationToken cancellationToken) => Task.FromResult(point);

        public Task<CuPoint> TranslateScreenPointAsync(
            string conversationId, CuPoint input, CancellationToken cancellationToken) =>
            Task.FromResult(screenOffset is null
                ? input
                : new CuPoint(input.X + screenOffset.X, input.Y + screenOffset.Y));
    }

    private static async Task<Dictionary<string, object?>> InvokeAsync(
        InputController module, string conversationId, string toolName, string inputJson)
    {
        using var document = JsonDocument.Parse(
            $"{{\"conversationId\":\"{conversationId}\",\"toolName\":\"{toolName}\"," +
            $"\"input\":{inputJson},\"stepNumber\":1}}");
        var result = await module.InvokeAsync("cu.perform", document.RootElement.Clone(), CancellationToken.None);
        return (Dictionary<string, object?>)result!;
    }

    private static void Check(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"Assertion failed: {label}");
        }
    }

    private static void CheckContains(Dictionary<string, object?> result, string fragment, string label) =>
        Check(
            result.GetValueOrDefault("executionError") is string error &&
                error.Contains(fragment, StringComparison.Ordinal),
            label);

    private static void CheckThrows(Action action, string label)
    {
        try
        {
            action();
        }
        catch (ArgumentException)
        {
            return;
        }
        throw new Exception($"Expected an ArgumentException: {label}");
    }
}
