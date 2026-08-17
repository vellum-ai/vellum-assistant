using System.Text.Json;
using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class ScreenCaptureTests
{
    private static readonly DisplayInfo Primary = new(0, new PixelRect(0, 0, 2560, 1440), true, 100);
    private static readonly DisplayInfo Secondary = new(1, new PixelRect(-1920, -200, 1920, 1200), false, 150);

    public static async ValueTask RunAsync()
    {
        var backend = new FakeBackend();
        var module = new ScreenCaptureModule(backend);

        var primary = await InvokeAsync(module, new { });
        Check(primary.GetProperty("bounds").GetProperty("width").GetInt32() == 2560,
            "default capture targets the primary display");
        Check(primary.GetProperty("scalePercent").GetInt32() == 100, "capture reports the display scale");
        Check(primary.GetProperty("pngBase64").GetString() == FakeBackend.Png, "capture returns the encoded image");
        Check(backend.LastCaptured == Primary.Bounds, "capture requests exactly the display bounds");

        var mixedDpi = await InvokeAsync(module, new { displayId = 1 });
        Check(mixedDpi.GetProperty("scalePercent").GetInt32() == 150 &&
            mixedDpi.GetProperty("bounds").GetProperty("x").GetInt32() == -1920 &&
            backend.LastCaptured == Secondary.Bounds,
            "mixed DPI displays keep physical bounds, negative origins, and their own scale");

        var missing = await InvokeAsync(module, new { displayId = 9 });
        Check(missing.GetProperty("unavailable").GetProperty("code").GetString() == Unavailable.NotFound,
            "unknown displays report not_found");
        Check(!missing.TryGetProperty("pngBase64", out _), "failed captures return no image");

        Console.WriteLine("Screen capture tests passed");
    }

    private static async ValueTask<JsonElement> InvokeAsync<T>(ScreenCaptureModule module, T parameters)
    {
        var result = await module.InvokeAsync(
            "capture.display", JsonSerializer.SerializeToElement(parameters), CancellationToken.None);
        return (JsonElement)result!;
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
}
