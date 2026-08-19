using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class WindowsCuObservationSourceTests
{
    public static async ValueTask RunAsync()
    {
        var snapshots = new FakeSnapshotSource
        {
            Snapshot = Available(Node(1, children: [Node(7, "Save", new PixelRect(20, 30, 100, 40))])),
        };
        var capture = new FakeCaptureSource
        {
            Result = new ComputerUseCapture("jpeg", 960, 540, 1920, 1080, null),
        };
        var source = new WindowsCuObservationSource(
            snapshots,
            capture,
            new ObservationSessionStore(TimeSpan.FromMinutes(10)));

        var first = await source.ObserveAsync("conv-1", 1, CancellationToken.None);
        Check(first.GetValueOrDefault("axTree") is string tree && tree.Contains("Save"),
            "full observation includes the accessibility tree");
        Check(first.GetValueOrDefault("screenshot") as string == "jpeg",
            "observation includes a JPEG screenshot");
        Check((int?)first.GetValueOrDefault("screenWidthPt") == 1920,
            "observation includes logical screen dimensions");

        var center = await source.ResolveElementCenterAsync(7, CancellationToken.None);
        Check(center == new CuPoint(70, 50), "element ids resolve to physical-pixel centers");

        snapshots.Snapshot = Available(
            Node(1, children: [Node(7, "Saved", new PixelRect(20, 30, 100, 40))]));
        var second = await source.ObserveAsync("conv-1", 2, CancellationToken.None);
        Check(second.ContainsKey("axTree") && second.GetValueOrDefault("axDiff") is string diff &&
            diff.Contains("Saved"), "diff observations include current and changed state");

        snapshots.Snapshot = new AutomationSnapshot(
            null, null, [], new Unavailable(Unavailable.NoForeground, "No foreground window"));
        capture.Result = new ComputerUseCapture(
            null, null, null, null, null,
            new Unavailable(Unavailable.CaptureDenied, "Screen capture failed"));
        var unavailable = await source.ObserveAsync("conv-2", 1, CancellationToken.None);
        Check(unavailable.GetValueOrDefault("executionError") is string error &&
            error.Contains("No foreground window") && error.Contains("Screen capture failed"),
            "fully unavailable observations return an execution error");

        Console.WriteLine("Windows computer-use observation tests passed");
    }

    private static AutomationSnapshot Available(AutomationNode tree) =>
        new(tree, new ForegroundApp("notepad", 1234, "Untitled"), [], null);

    private static AutomationNode Node(
        long id,
        string? name = null,
        PixelRect? bounds = null,
        IReadOnlyList<AutomationNode>? children = null) =>
        new(
            id,
            "ControlType.Button",
            name,
            null,
            false,
            false,
            false,
            true,
            bounds ?? new PixelRect(0, 0, 100, 40),
            children ?? []);

    private static void Check(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"Windows computer-use observation assertion failed: {label}");
        }
    }

    private sealed class FakeSnapshotSource : IAutomationSnapshotSource
    {
        public required AutomationSnapshot Snapshot { get; set; }

        public AutomationSnapshot TakeSnapshot(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Snapshot;
        }
    }

    private sealed class FakeCaptureSource : IComputerUseCaptureSource
    {
        public required ComputerUseCapture Result { get; set; }

        public ComputerUseCapture Capture(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Result;
        }
    }
}
