using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class PushToTalkChordTrackerTests
{
    public static void Run()
    {
        SingleKeyRequiresHold();
        ExtraKeyCancelsPendingActivation();
        ChordActivatesImmediately();
        ReconfigurationReleasesActiveChord();
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

    private static void ReconfigurationReleasesActiveChord()
    {
        var tracker = new PushToTalkChordTracker();
        tracker.Configure([0x11, 0x10]);
        tracker.KeyDown(0x11);
        tracker.KeyDown(0x10);
        Assert(tracker.Configure([0x12]) == PushToTalkTransition.Up);
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("Push-to-talk chord tracker assertion failed");
        }
    }
}
