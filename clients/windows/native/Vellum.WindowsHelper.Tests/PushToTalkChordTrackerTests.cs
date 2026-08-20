using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class PushToTalkChordTrackerTests
{
    public static void Run()
    {
        SingleKeyRequiresHold();
        ExtraKeyCancelsPendingActivation();
        ChordRequiresHold();
        ExtraKeyCancelsPendingChord();
        RejectsNonModifierGlobalBindings();
        ReconfigurationReleasesActiveChord();
        KeepsSidedModifiersPressed();
    }

    private static void SingleKeyRequiresHold()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11]);
        Assert(tracker.KeyDown(0x11) == PushToTalkTransition.Pending);
        Assert(tracker.ActivatePending() == PushToTalkTransition.Down);
        Assert(tracker.KeyUp(0x11) == PushToTalkTransition.Up);
    }

    private static void ExtraKeyCancelsPendingActivation()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x12]);
        Assert(tracker.KeyDown(0x12) == PushToTalkTransition.Pending);
        Assert(tracker.KeyDown(0x43) == PushToTalkTransition.None);
        Assert(tracker.ActivatePending() == PushToTalkTransition.None);
    }

    private static void ChordRequiresHold()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        Assert(tracker.KeyDown(0x11) == PushToTalkTransition.None);
        Assert(tracker.KeyDown(0x10) == PushToTalkTransition.Pending);
        Assert(tracker.ActivatePending() == PushToTalkTransition.Down);
        Assert(tracker.KeyUp(0x11) == PushToTalkTransition.Up);
    }

    private static void ExtraKeyCancelsPendingChord()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        Assert(tracker.KeyDown(0x10) == PushToTalkTransition.Pending);
        Assert(tracker.KeyDown(0x54) == PushToTalkTransition.None);
        Assert(!tracker.Pending);
        Assert(tracker.ActivatePending() == PushToTalkTransition.None);
        Assert(tracker.KeyUp(0x10) == PushToTalkTransition.None);
    }

    private static void RejectsNonModifierGlobalBindings()
    {
        using var service = new PushToTalkService();
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
            PushToTalkService.SetMethod,
            parameters,
            CancellationToken.None).AsTask().GetAwaiter().GetResult();
        var json = JsonSerializer.SerializeToElement(response);
        Assert(!json.GetProperty("ok").GetBoolean());
        Assert(json.GetProperty("reason").GetString() ==
            "Global push-to-talk supports modifier-only bindings");
    }

    private static void ReconfigurationReleasesActiveChord()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        tracker.KeyDown(0x10);
        Assert(tracker.Configure([0x12]) == PushToTalkTransition.Up);
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
            throw new Exception("Push-to-talk chord tracker assertion failed");
        }
    }
}
