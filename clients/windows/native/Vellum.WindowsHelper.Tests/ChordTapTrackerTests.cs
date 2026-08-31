using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class ChordTapTrackerTests
{
    public static void Run()
    {
        CleanTapFires();
        ChordTapFiresOnFirstChordKeyRelease();
        ExtraKeyDisarmsTap();
        PassingShortcutNeverFires();
        RearmsAfterPartialRelease();
        ReconfigurationDisarms();
        RejectsNonModifierGlobalBindings();
        KeepsSidedModifiersPressed();
    }

    private static void CleanTapFires()
    {
        var tracker = new ChordTapTracker();
        tracker.Configure([0x11]);
        tracker.KeyDown(0x11);
        Assert(tracker.Armed);
        Assert(tracker.KeyUp(0x11));
        Assert(!tracker.Armed);
    }

    private static void ChordTapFiresOnFirstChordKeyRelease()
    {
        var tracker = new ChordTapTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        Assert(!tracker.Armed);
        tracker.KeyDown(0x10);
        Assert(tracker.Armed);
        Assert(tracker.KeyUp(0x11));
        Assert(!tracker.KeyUp(0x10));
    }

    private static void ExtraKeyDisarmsTap()
    {
        var tracker = new ChordTapTracker();
        tracker.Configure([0x12]);
        tracker.KeyDown(0x12);
        Assert(tracker.Armed);
        tracker.KeyDown(0x43);
        Assert(!tracker.Armed);
        Assert(!tracker.KeyUp(0x43));
        Assert(!tracker.KeyUp(0x12));
    }

    private static void PassingShortcutNeverFires()
    {
        // Ctrl+Shift bound; Ctrl+Shift+T passes through the chord's keys.
        var tracker = new ChordTapTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        tracker.KeyDown(0x10);
        tracker.KeyDown(0x54);
        Assert(!tracker.KeyUp(0x54));
        Assert(!tracker.KeyUp(0x10));
        Assert(!tracker.KeyUp(0x11));
    }

    private static void RearmsAfterPartialRelease()
    {
        var tracker = new ChordTapTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        tracker.KeyDown(0x10);
        Assert(tracker.KeyUp(0x10));
        // Ctrl is still held; tapping Shift again completes the chord again.
        tracker.KeyDown(0x10);
        Assert(tracker.Armed);
        Assert(tracker.KeyUp(0x10));
    }

    private static void ReconfigurationDisarms()
    {
        var tracker = new ChordTapTracker();
        tracker.Configure([0x11]);
        tracker.KeyDown(0x11);
        Assert(tracker.Armed);
        tracker.Configure([0x12]);
        Assert(!tracker.Armed);
        Assert(!tracker.KeyUp(0x11));
    }

    private static void RejectsNonModifierGlobalBindings()
    {
        using var service = new VoiceModeChordService();
        var parameters = JsonSerializer.SerializeToElement(new
        {
            activator = new
            {
                kind = "key",
                modifiers = Array.Empty<string>(),
                label = "K",
            },
        });
        var response = service.InvokeAsync(
            VoiceModeChordService.SetMethod,
            parameters,
            CancellationToken.None).AsTask().GetAwaiter().GetResult();
        var json = JsonSerializer.SerializeToElement(response);
        Assert(!json.GetProperty("ok").GetBoolean());
        Assert(json.GetProperty("reason").GetString() ==
            "The voice mode chord supports modifier-only bindings");
    }

    private static void KeepsSidedModifiersPressed()
    {
        var tracker = new PhysicalKeyTracker();
        Assert(tracker.Observe(0xA2, true) == new PhysicalKeyTransition(0x11, true));
        Assert(tracker.Observe(0xA3, true) is null);
        Assert(tracker.Observe(0xA2, false) is null);
        Assert(tracker.Observe(0xA3, false) == new PhysicalKeyTransition(0x11, false));
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("Chord tap tracker assertion failed");
        }
    }
}
