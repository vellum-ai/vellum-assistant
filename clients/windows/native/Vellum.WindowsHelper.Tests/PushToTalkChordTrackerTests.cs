using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class PushToTalkChordTrackerTests
{
    public static void Run()
    {
        SingleKeyRequiresHold();
        ExtraKeyCancelsPendingActivation();
        ChordActivatesImmediately();
        ConfiguredKeysAreConsumed();
        ReconfigurationReleasesActiveChord();
        ResolvesBrowserKeyLabels();
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

    private static void ChordActivatesImmediately()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        Assert(tracker.KeyDown(0x11) == PushToTalkTransition.None);
        Assert(tracker.KeyDown(0x10) == PushToTalkTransition.Down);
        Assert(tracker.KeyUp(0x11) == PushToTalkTransition.Up);
    }

    private static void ConfiguredKeysAreConsumed()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        Assert(tracker.Consumes(0x11));
        Assert(tracker.Consumes(0x10));
        Assert(!tracker.Consumes(0x4B));
    }

    private static void ReconfigurationReleasesActiveChord()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        tracker.KeyDown(0x10);
        Assert(tracker.Configure([0x12]) == PushToTalkTransition.Up);
    }

    private static void ResolvesBrowserKeyLabels()
    {
        Assert(PushToTalkKeyPlanner.ResolveKey(" ") == 0x20);
        Assert(PushToTalkKeyPlanner.ResolveKey("ArrowUp") == 0x26);
        Assert(PushToTalkKeyPlanner.ResolveKey("?") == 0xBF);
        Assert(PushToTalkKeyPlanner.ResolveKey("!") == 0x31);
        Assert(PushToTalkKeyPlanner.ResolveKey("@") == 0x32);
        Assert(PushToTalkKeyPlanner.ResolveKey(")") == 0x30);
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
