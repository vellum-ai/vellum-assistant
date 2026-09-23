using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

public sealed class CompanionCapture : IRpcModule
{
    public IReadOnlyCollection<string> Methods { get; } = ["captureSources.list", "captureSources.raise", "ax.locate"];

    public ValueTask<object?> InvokeAsync(string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        ProcessDpi.EnsureAwareness();
        if (method == "ax.locate")
        {
            var input = parameters ?? throw new ArgumentException("Missing target");
            var window = input.TryGetProperty("windowId", out var id)
                ? new IntPtr(id.GetInt64()) : new WindowsWindowTargetSource().GetTargetWindow();
            var snapshot = new UiaSnapshotSource(new TargetWindow(window)).TakeSnapshot(cancellationToken);
            return ValueTask.FromResult<object?>(CompanionLocator.Find(snapshot.Tree, input.GetProperty("query").GetString() ?? ""));
        }
        if (method == "captureSources.raise")
        {
            var id = parameters?.GetProperty("windowId").GetInt64() ?? 0;
            var window = new IntPtr(id);
            if (!IsWindow(window))
            {
                return ValueTask.FromResult<object?>(new { raised = false });
            }
            if (IsIconic(window))
            {
                ShowWindow(window, 9);
            }
            return ValueTask.FromResult<object?>(new { raised = SetForegroundWindow(window) });
        }
        var includeOffscreen = parameters is { } options && options.TryGetProperty("includeOffscreen", out var include) && include.GetBoolean();
        var windows = new List<object>();
        EnumWindows((window, _) =>
        {
            if (cancellationToken.IsCancellationRequested) { return false; }
            var visible = IsWindowVisible(window) && !IsIconic(window);
            _ = DwmGetWindowAttribute(window, 14, out int cloaked, sizeof(int));
            visible = visible && cloaked == 0;
            if ((!visible && !includeOffscreen) || !GetWindowRect(window, out var bounds))
            {
                return true;
            }
            if (DwmGetWindowRect(window, 9, out var visibleBounds, Marshal.SizeOf<Rect>()) == 0)
            {
                bounds = visibleBounds;
            }
            var title = new StringBuilder(1024);
            GetWindowText(window, title, title.Capacity);
            if (title.Length == 0 || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top)
            {
                return true;
            }
            GetWindowThreadProcessId(window, out var pid);
            string name;
            try
            {
                using var process = Process.GetProcessById((int)pid);
                name = process.ProcessName;
            }
            catch (ArgumentException)
            {
                return true;
            }
            windows.Add(new {
                windowId = window.ToInt64(), pid, app = name, title = title.ToString(), onScreen = visible,
                bounds = new { x = bounds.Left, y = bounds.Top, width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top },
            });
            return true;
        }, IntPtr.Zero);
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult<object?>(new { windows });
    }

    private sealed class TargetWindow(IntPtr window) : IWindowTargetSource
    {
        public IntPtr GetTargetWindow() => window;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowRect(IntPtr window, int attribute, out Rect value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
}
