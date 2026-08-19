using System.Drawing;
using System.Drawing.Imaging;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class WindowsCuObservationSourceTests
{
    public static async ValueTask RunAsync()
    {
        TestJpegCapture();
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
            "observation includes input-space screen dimensions");
        Check(capture.LastTargetBounds == new PixelRect(0, 0, 100, 40),
            "screen capture follows the observed target display");

        capture.Result = new ComputerUseCapture(
            "jpeg", 960, 540, 1920, 1080, null, -1920, -200);
        await source.ObserveAsync("conv-secondary", 1, CancellationToken.None);
        var screenPoint = await source.TranslateScreenPointAsync(
            "conv-secondary", new CuPoint(20, 30), CancellationToken.None);
        Check(screenPoint == new CuPoint(-1900, -170),
            "secondary-display screenshot coordinates map to virtual desktop pixels");

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

    private static void TestJpegCapture()
    {
        var capture = new GdiComputerUseCaptureSource(
            new ScreenCaptureService(new ImageBackend())).Capture(null, CancellationToken.None);
        Check(capture.JpegBase64?.StartsWith("/9j/", StringComparison.Ordinal) == true,
            "computer use emits JPEG data");
        Check(capture is { ScreenshotWidthPx: 810, ScreenshotHeightPx: 540 },
            "computer-use screenshots fit the observation budget");
        Check(capture is { ScreenWidthPt: 1200, ScreenHeightPt: 800 },
            "computer use advertises the physical input coordinate space");
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
        public PixelRect? LastTargetBounds { get; private set; }

        public ComputerUseCapture Capture(
            PixelRect? targetBounds, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastTargetBounds = targetBounds;
            return Result;
        }
    }

    private sealed class ImageBackend : IScreenCaptureBackend
    {
        public IReadOnlyList<DisplayInfo> GetDisplays() =>
            [new DisplayInfo(0, new PixelRect(0, 0, 1200, 800), true, 125)];

        public CapturedImage CapturePixels(PixelRect bounds)
        {
            using var bitmap = new Bitmap(bounds.Width, bounds.Height);
            using var stream = new MemoryStream();
            bitmap.Save(stream, ImageFormat.Png);
            return new CapturedImage(
                Convert.ToBase64String(stream.ToArray()), bounds.Width, bounds.Height);
        }
    }
}
