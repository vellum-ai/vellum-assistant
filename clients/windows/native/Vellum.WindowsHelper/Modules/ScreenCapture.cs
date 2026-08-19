using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Vellum.WindowsHelper.Modules;

public sealed record DisplayInfo(int Id, PixelRect Bounds, bool Primary, int ScalePercent);

public sealed record CapturedImage(string PngBase64, int WidthPx, int HeightPx);

public sealed record CaptureResult(
    string? PngBase64, int? WidthPx, int? HeightPx, PixelRect? Bounds,
    int? ScalePercent, Unavailable? Unavailable);

/// <summary>Capture backend abstraction so display routing logic is testable off GDI.</summary>
public interface IScreenCaptureBackend
{
    IReadOnlyList<DisplayInfo> GetDisplays();

    CapturedImage CapturePixels(PixelRect bounds);
}

public sealed class ScreenCaptureService(IScreenCaptureBackend backend)
{
    public CaptureResult CaptureDisplay(int? displayId, PixelRect? targetBounds = null)
    {
        var displays = backend.GetDisplays();
        DisplayInfo? display;
        if (displayId is { } id)
        {
            display = displays.FirstOrDefault(candidate => candidate.Id == id);
        }
        else if (targetBounds is { } target)
        {
            display = displays.FirstOrDefault(candidate => ContainsCenter(candidate.Bounds, target));
        }
        else
        {
            display = displays.FirstOrDefault(candidate => candidate.Primary) ?? displays.FirstOrDefault();
        }
        if (display is null)
        {
            var reason = new Unavailable(Unavailable.NotFound, "The requested display was not found");
            return new CaptureResult(null, null, null, null, null, reason);
        }
        try
        {
            var image = backend.CapturePixels(display.Bounds);
            return new CaptureResult(
                image.PngBase64, image.WidthPx, image.HeightPx, display.Bounds, display.ScalePercent, null);
        }
        catch (Exception ex) when (ex is ExternalException or InvalidOperationException)
        {
            return new CaptureResult(null, null, null, null, null,
                new Unavailable(Unavailable.CaptureDenied, "The display could not be captured"));
        }
    }

    private static bool ContainsCenter(PixelRect display, PixelRect target)
    {
        var x = target.X + target.Width / 2.0;
        var y = target.Y + target.Height / 2.0;
        return x >= display.X && x < display.X + display.Width &&
            y >= display.Y && y < display.Y + display.Height;
    }
}

/// <summary>
/// GDI screen-space capture. Capturing from the same physical-pixel virtual
/// desktop space that observation bounds use keeps screenshots, element
/// bounds, and window bounds aligned across monitor arrangements and mixed
/// DPI, including displays at negative virtual desktop origins.
/// </summary>
public sealed class GdiScreenCapture : IScreenCaptureBackend
{
    public IReadOnlyList<DisplayInfo> GetDisplays()
    {
        ProcessDpi.EnsureAwareness();
        var screens = System.Windows.Forms.Screen.AllScreens;
        var displays = new List<DisplayInfo>(screens.Length);
        for (var i = 0; i < screens.Length; i++)
        {
            var bounds = screens[i].Bounds;
            var pixelBounds = new PixelRect(bounds.X, bounds.Y, bounds.Width, bounds.Height);
            displays.Add(new DisplayInfo(i, pixelBounds, screens[i].Primary, ScalePercentAt(bounds)));
        }
        return displays;
    }

    public CapturedImage CapturePixels(PixelRect bounds)
    {
        ProcessDpi.EnsureAwareness();
        using var bitmap = new Bitmap(bounds.Width, bounds.Height);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, new Size(bounds.Width, bounds.Height));
        }
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return new CapturedImage(Convert.ToBase64String(stream.ToArray()), bounds.Width, bounds.Height);
    }

    private static int ScalePercentAt(Rectangle bounds)
    {
        var center = new NativePoint(bounds.X + bounds.Width / 2, bounds.Y + bounds.Height / 2);
        var monitor = CaptureNativeMethods.MonitorFromPoint(center, 2);
        if (monitor == IntPtr.Zero ||
            CaptureNativeMethods.GetDpiForMonitor(monitor, 0, out var dpiX, out _) != 0)
        {
            return 100;
        }
        return (int)Math.Round(dpiX * 100.0 / 96.0);
    }
}

[StructLayout(LayoutKind.Sequential)]
file struct NativePoint(int x, int y)
{
    public int X = x;
    public int Y = y;
}

file static class CaptureNativeMethods
{
    [DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromPoint(NativePoint point, uint flags);

    [DllImport("shcore.dll")]
    internal static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
}
