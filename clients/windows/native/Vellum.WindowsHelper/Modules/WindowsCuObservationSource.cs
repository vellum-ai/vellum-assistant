using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Vellum.WindowsHelper.Modules;

public sealed record ComputerUseCapture(
    string? JpegBase64,
    int? ScreenshotWidthPx,
    int? ScreenshotHeightPx,
    int? ScreenWidthPt,
    int? ScreenHeightPt,
    Unavailable? Unavailable,
    int ScreenOriginX = 0,
    int ScreenOriginY = 0);

public interface IComputerUseCaptureSource
{
    ComputerUseCapture Capture(PixelRect? targetBounds, CancellationToken cancellationToken);
}

public sealed class WindowsCuObservationSource : ICuObservationSource
{
    private readonly IAutomationSnapshotSource _snapshots;
    private readonly AutomationObserver _observer;
    private readonly IComputerUseCaptureSource _capture;
    private readonly ConcurrentDictionary<string, CuPoint> _screenOrigins = new();

    public WindowsCuObservationSource()
        : this(
            new UiaSnapshotSource(),
            new GdiComputerUseCaptureSource(
                new ScreenCaptureService(new GdiScreenCapture())))
    {
    }

    public WindowsCuObservationSource(
        IAutomationSnapshotSource snapshots,
        IComputerUseCaptureSource capture,
        ObservationSessionStore? sessions = null)
    {
        _snapshots = snapshots;
        _observer = new AutomationObserver(
            snapshots, sessions ?? new ObservationSessionStore(TimeSpan.FromMinutes(15)));
        _capture = capture;
    }

    public Task<IReadOnlyDictionary<string, object?>> ObserveAsync(
        string conversationId, int stepNumber, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var observation = _observer.Observe(
            conversationId, stepNumber > 1 ? "diff" : "full", cancellationToken);
        var capture = _capture.Capture(observation.TargetBounds, cancellationToken);
        if (capture.JpegBase64 is not null)
        {
            _screenOrigins[conversationId] = new CuPoint(
                capture.ScreenOriginX, capture.ScreenOriginY);
        }
        else
        {
            _screenOrigins.TryRemove(conversationId, out _);
        }
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        Add(result, "axTree", observation.Tree);
        Add(result, "axDiff", observation.Diff);
        if (observation.SecondaryWindows != "[]")
        {
            Add(result, "secondaryWindows", observation.SecondaryWindows);
        }
        Add(result, "screenshot", capture.JpegBase64);
        Add(result, "screenshotWidthPx", capture.ScreenshotWidthPx);
        Add(result, "screenshotHeightPx", capture.ScreenshotHeightPx);
        Add(result, "screenWidthPt", capture.ScreenWidthPt);
        Add(result, "screenHeightPt", capture.ScreenHeightPt);

        var warnings = new[] { observation.Unavailable, capture.Unavailable }
            .Where(reason => reason is not null)
            .Select(reason => reason!.Message)
            .ToArray();
        if (warnings.Length > 0)
        {
            result[observation.Tree is null && capture.JpegBase64 is null
                ? "executionError"
                : "userGuidance"] = string.Join("; ", warnings);
        }
        return Task.FromResult<IReadOnlyDictionary<string, object?>>(result);
    }

    public Task<CuPoint?> ResolveElementCenterAsync(
        long elementId, CancellationToken cancellationToken)
    {
        var snapshot = _snapshots.TakeSnapshot(cancellationToken);
        var node = Find(snapshot.Tree, elementId);
        if (node is null || node.Bounds.Width <= 0 || node.Bounds.Height <= 0)
        {
            return Task.FromResult<CuPoint?>(null);
        }
        return Task.FromResult<CuPoint?>(new CuPoint(
            node.Bounds.X + node.Bounds.Width / 2.0,
            node.Bounds.Y + node.Bounds.Height / 2.0));
    }

    public Task<CuPoint> TranslateScreenPointAsync(
        string conversationId, CuPoint point, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var origin = _screenOrigins.GetValueOrDefault(conversationId);
        return Task.FromResult(origin is null
            ? point
            : new CuPoint(point.X + origin.X, point.Y + origin.Y));
    }

    private static AutomationNode? Find(AutomationNode? root, long id)
    {
        if (root is null)
        {
            return null;
        }
        var stack = new Stack<AutomationNode>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            if (node.Id == id)
            {
                return node;
            }
            foreach (var child in node.Children)
            {
                stack.Push(child);
            }
        }
        return null;
    }

    private static void Add(
        IDictionary<string, object?> result, string key, object? value)
    {
        if (value is not null)
        {
            result[key] = value;
        }
    }
}

public sealed class GdiComputerUseCaptureSource(ScreenCaptureService service)
    : IComputerUseCaptureSource
{
    private const int MaxScreenshotWidth = 960;
    private const int MaxScreenshotHeight = 540;

    public ComputerUseCapture Capture(
        PixelRect? targetBounds, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var captured = service.CaptureDisplay(null, targetBounds);
        if (captured.PngBase64 is null || captured.Bounds is null ||
            captured.WidthPx is null || captured.HeightPx is null)
        {
            return new ComputerUseCapture(null, null, null, null, null, captured.Unavailable);
        }
        try
        {
            var (jpeg, width, height) = ConvertToJpeg(
                captured.PngBase64, captured.WidthPx.Value, captured.HeightPx.Value);
            return new ComputerUseCapture(
                jpeg,
                width,
                height,
                captured.Bounds.Width,
                captured.Bounds.Height,
                null,
                captured.Bounds.X,
                captured.Bounds.Y);
        }
        catch (Exception ex) when (ex is ArgumentException or ExternalException or FormatException)
        {
            return new ComputerUseCapture(
                null, null, null, null, null,
                new Unavailable(Unavailable.CaptureDenied, "The display image could not be encoded"));
        }
    }

    private static (string Jpeg, int Width, int Height) ConvertToJpeg(
        string pngBase64, int sourceWidth, int sourceHeight)
    {
        var scale = Math.Min(
            1,
            Math.Min(
                MaxScreenshotWidth / (double)Math.Max(1, sourceWidth),
                MaxScreenshotHeight / (double)Math.Max(1, sourceHeight)));
        var width = Math.Max(1, (int)Math.Round(sourceWidth * scale));
        var height = Math.Max(1, (int)Math.Round(sourceHeight * scale));
        using var input = new MemoryStream(Convert.FromBase64String(pngBase64));
        using var source = Image.FromStream(input);
        using var target = new Bitmap(width, height);
        using (var graphics = Graphics.FromImage(target))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(source, 0, 0, width, height);
        }
        using var output = new MemoryStream();
        target.Save(output, ImageFormat.Jpeg);
        return (Convert.ToBase64String(output.ToArray()), width, height);
    }
}
