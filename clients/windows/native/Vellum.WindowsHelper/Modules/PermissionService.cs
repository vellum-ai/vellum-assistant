using System.Text.Json;
using Microsoft.Win32;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Reports the Windows capability state behind the desktop app's system
/// permissions surface. Each kind maps to the user-controlled privacy
/// setting that actually gates it; kinds with no Windows equivalent are
/// omitted and the Electron host reports those as not applicable.
/// </summary>
public sealed class PermissionService : IRpcModule, INativeCapability
{
    public const string StateMethod = "permissions.state";

    private const string MicrophoneConsentPath =
        @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    private const string OnlineSpeechPath =
        @"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy";
    private const string PushNotificationsPath =
        @"Software\Microsoft\Windows\CurrentVersion\PushNotifications";

    private readonly Func<string, string, object?> _readCurrentUserValue;

    public PermissionService()
        : this(ReadCurrentUserValue)
    {
    }

    public PermissionService(Func<string, string, object?> readCurrentUserValue)
    {
        _readCurrentUserValue = readCurrentUserValue;
    }

    public string CapabilityId => "permissions";

    public IReadOnlyCollection<string> Methods { get; } = [StateMethod];

    public ValueTask<object?> InvokeAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken) =>
        ValueTask.FromResult<object?>(QueryState());

    public object QueryState() => new
    {
        microphone = MapMicrophoneConsent(
            _readCurrentUserValue(MicrophoneConsentPath, "Value"),
            _readCurrentUserValue($@"{MicrophoneConsentPath}\NonPackaged", "Value")),
        speechRecognition = MapOnlineSpeech(
            _readCurrentUserValue(OnlineSpeechPath, "HasAccepted")),
        notifications = MapToastEnabled(
            _readCurrentUserValue(PushNotificationsPath, "ToastEnabled")),
    };

    // Desktop apps are gated by the global microphone consent plus the
    // non-packaged app consent; a deny on either wins.
    public static string MapMicrophoneConsent(object? global, object? nonPackaged)
    {
        if (IsDenyConsent(global) || IsDenyConsent(nonPackaged))
        {
            return "denied";
        }
        if (IsAllowConsent(global) && (nonPackaged is null || IsAllowConsent(nonPackaged)))
        {
            return "granted";
        }
        return "unknown";
    }

    public static string MapOnlineSpeech(object? hasAccepted) => hasAccepted switch
    {
        int accepted when accepted != 0 => "granted",
        int => "denied",
        null => "not-determined",
        _ => "unknown",
    };

    // Toasts are enabled unless the user turned them off.
    public static string MapToastEnabled(object? toastEnabled) => toastEnabled switch
    {
        int enabled when enabled == 0 => "denied",
        _ => "granted",
    };

    private static bool IsAllowConsent(object? value) =>
        value is string text && string.Equals(text, "Allow", StringComparison.OrdinalIgnoreCase);

    private static bool IsDenyConsent(object? value) =>
        value is string text && string.Equals(text, "Deny", StringComparison.OrdinalIgnoreCase);

    private static object? ReadCurrentUserValue(string path, string name)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(path);
            return key?.GetValue(name);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or IOException)
        {
            return null;
        }
    }
}
