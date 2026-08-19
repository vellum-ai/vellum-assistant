using System.Runtime.InteropServices;

namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Process-wide per-monitor-v2 DPI awareness, applied once. Observation bounds
/// and screen captures both need it so they share one physical-pixel virtual
/// desktop space. The call fails harmlessly when the context is already set.
/// </summary>
internal static class ProcessDpi
{
    private const int PerMonitorAwareV2 = -4;

    private static bool _applied;

    internal static void EnsureAwareness()
    {
        if (!_applied)
        {
            _applied = true;
            _ = SetProcessDpiAwarenessContext(new IntPtr(PerMonitorAwareV2));
        }
    }

    [DllImport("user32.dll")]
    private static extern int SetProcessDpiAwarenessContext(IntPtr context);
}
