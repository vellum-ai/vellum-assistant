using System.Runtime.InteropServices;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class ScreenCaptureTests
{
    private static readonly DisplayInfo Primary = new(0, new PixelRect(0, 0, 2560, 1440), true, 100);
    private static readonly DisplayInfo Secondary = new(1, new PixelRect(-1920, -200, 1920, 1200), false, 150);

    public static ValueTask RunAsync()
    {
        var backend = new FakeBackend();
        var service = new ScreenCaptureService(backend);

        var primary = service.CaptureDisplay(null);
        Check(primary.Bounds == Primary.Bounds && primary.ScalePercent == 100,
            "default capture targets the primary display");
        Check(primary.PngBase64 == FakeBackend.Png, "capture returns the encoded image");
        Check(backend.LastCaptured == Primary.Bounds, "capture requests exactly the display bounds");

        var mixedDpi = service.CaptureDisplay(1);
        Check(mixedDpi.ScalePercent == 150 && mixedDpi.Bounds == Secondary.Bounds &&
            backend.LastCaptured == Secondary.Bounds,
            "mixed DPI displays keep physical bounds, negative origins, and their own scale");

        var routed = service.CaptureDisplay(null, new PixelRect(-1800, 0, 800, 600));
        Check(routed.Bounds == Secondary.Bounds,
            "computer use captures the display containing the target window");

        var missing = service.CaptureDisplay(9);
        Check(missing.Unavailable?.Code == Unavailable.NotFound && missing.PngBase64 is null,
            "unknown displays report not_found without image data");

        var thrown = new ScreenCaptureService(new ThrowingBackend()).CaptureDisplay(null);
        Check(thrown.Unavailable?.Code == Unavailable.CaptureDenied,
            "capture failures return structured capture_denied");

        Console.WriteLine("Screen capture tests passed");
        return ValueTask.CompletedTask;
    }

    private static void Check(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"Screen capture assertion failed: {label}");
        }
    }

    private sealed class FakeBackend : IScreenCaptureBackend
    {
        public const string Png = "cGl4ZWxz";

        public PixelRect? LastCaptured { get; private set; }

        public IReadOnlyList<DisplayInfo> GetDisplays() => [Primary, Secondary];

        public CapturedImage CapturePixels(PixelRect bounds)
        {
            LastCaptured = bounds;
            return new CapturedImage(Png, bounds.Width, bounds.Height);
        }
    }

    private sealed class ThrowingBackend : IScreenCaptureBackend
    {
        public IReadOnlyList<DisplayInfo> GetDisplays() => [Primary];

        public CapturedImage CapturePixels(PixelRect bounds) => throw new ExternalException("denied");
    }
}
