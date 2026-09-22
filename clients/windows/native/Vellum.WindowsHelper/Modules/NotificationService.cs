using System.Security;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;
using Vellum.WindowsHelper.Rpc;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Windows toast delivery with action buttons. The Electron shell owns
/// categories, cooldown, dedup, and metadata routing
/// (packages/electron-desktop/src/notifications.ts); this module turns a
/// prepared request into an OS toast under a stable AppUserModelId, emits a
/// `notifications/event` JSON-RPC notification (keyed by the caller's opaque
/// token) on click or action-button press, and acks the real OS outcome
/// (settings-disabled or a rejected post fail), never optimistic success.
/// </summary>
public sealed class NotificationService : IRpcModule, INotificationAdapter
{
    public const string AppUserModelId = "Vellum.Assistant";
    public const string ShowMethod = "notifications/show";
    public const string EventMethod = "notifications/event";

    private static bool _appIdRegistered;

    // Live toasts are pinned so their activation handlers survive until the
    // OS dismisses them; bounded in case dismissal events never arrive.
    private const int MaxTrackedToasts = 200;
    private readonly object _gate = new();
    private readonly Dictionary<string, ToastNotification> _liveToasts =
        new(StringComparer.Ordinal);

    // Windows reports a rejected post asynchronously via ToastNotification
    // .Failed; the ack waits this long for it so a rejection is not
    // acknowledged as delivered.
    private const int FailedEventGraceMs = 250;

    private readonly Func<ShowRequest, ValueTask<ShowResponse>> _deliver;

    public NotificationService() => _deliver = Deliver;

    /// <summary>Test seam: replaces the OS delivery path.</summary>
    public NotificationService(Func<ShowRequest, ValueTask<ShowResponse>> deliver) =>
        _deliver = deliver;

    public string CapabilityId => "notifications";

    public IReadOnlyCollection<string> Methods { get; } = [ShowMethod];

    public async ValueTask<object?> InvokeAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken)
    {
        if (method != ShowMethod)
        {
            throw new RpcMethodNotFoundException(method);
        }
        return TryParseShowRequest(parameters, out var request, out var error)
            ? await _deliver(request)
            : new ShowResponse(false, error);
    }

    public sealed record ShowRequest(
        string Token,
        string Title,
        string? Subtitle,
        string Body,
        IReadOnlyList<string> Actions,
        string? AvatarPath);

    public sealed record ShowResponse(
        [property: JsonPropertyName("success")] bool Success,
        [property: JsonPropertyName("errorMessage")]
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        string? ErrorMessage);

    private sealed record RawShow(
        string? Token,
        string? Title,
        string? Subtitle,
        string? Body,
        List<RawAction>? Actions,
        string? AvatarPath);

    private sealed record RawAction(string? Text);

    private static readonly JsonSerializerOptions ParseOptions =
        new() { PropertyNameCaseInsensitive = true };

    public static bool TryParseShowRequest(
        JsonElement? parameters,
        out ShowRequest request,
        out string error)
    {
        request = new ShowRequest(string.Empty, string.Empty, null, string.Empty, [], null);
        error = "params must carry token, title, body, and action text strings";
        RawShow? raw;
        try
        {
            raw = parameters is { ValueKind: JsonValueKind.Object } element
                ? element.Deserialize<RawShow>(ParseOptions)
                : null;
        }
        catch (JsonException)
        {
            return false;
        }
        var actions = raw?.Actions ?? [];
        if (raw is not
            {
                Token: { } token,
                Title: { } title,
                Body: { } body,
                Subtitle: var subtitle,
                AvatarPath: var avatarPath,
            } ||
            actions.Any(action => action?.Text is null))
        {
            return false;
        }
        request = new ShowRequest(
            token,
            title,
            NullIfEmpty(subtitle),
            body,
            [.. actions.Select(action => action!.Text!)],
            NullIfEmpty(avatarPath));
        error = string.Empty;
        return true;
    }

    private static string? NullIfEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    /// <summary>Toast XML: title, an optional subtitle, body text, an optional
    /// circular sender image in the app-logo slot (Windows keeps the app name
    /// in the attribution line below), and one foreground button per action.
    /// Arguments carry only the interaction kind and button index; the caller
    /// token stays in the activation handler's closure.</summary>
    public static string BuildToastXml(ShowRequest request)
    {
        var builder = new StringBuilder()
            .Append("<toast activationType=\"foreground\" launch=\"kind=click\">")
            .Append("<visual><binding template=\"ToastGeneric\"><text>")
            .Append(SecurityElement.Escape(request.Title))
            .Append("</text>");
        if (request.Subtitle is { } subtitle)
        {
            builder.Append("<text>").Append(SecurityElement.Escape(subtitle)).Append("</text>");
        }
        builder.Append("<text>").Append(SecurityElement.Escape(request.Body)).Append("</text>");
        if (ToFileUri(request.AvatarPath) is { } avatarUri)
        {
            builder
                .Append("<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"")
                .Append(SecurityElement.Escape(avatarUri))
                .Append("\"/>");
        }
        builder.Append("</binding></visual>");
        if (request.Actions.Count > 0)
        {
            builder.Append("<actions>");
            for (var index = 0; index < request.Actions.Count; index++)
            {
                builder
                    .Append("<action activationType=\"foreground\" content=\"")
                    .Append(SecurityElement.Escape(request.Actions[index]))
                    .Append($"\" arguments=\"kind=action;index={index}\"/>");
            }
            builder.Append("</actions>");
        }
        return builder.Append("</toast>").ToString();
    }

    private static readonly char[] PathSeparators = ['\\', '/'];

    /// <summary>The `file:///` form of a drive-rooted local path: the drive
    /// kept verbatim, every following segment percent-encoded, separators
    /// flipped to forward slashes. Null for anything a toast image cannot
    /// load, including relative paths and UNC shares. The URI is assembled
    /// from the path's own segments rather than parsed out of it, so a literal
    /// `%` in a folder name stays encoded and keeps naming the file the avatar
    /// was written to.</summary>
    private static string? ToFileUri(string? avatarPath)
    {
        if (avatarPath is null)
        {
            return null;
        }
        var segments = avatarPath.Split(PathSeparators);
        if (segments.Length < 2 ||
            segments[0].Length != 2 ||
            !char.IsAsciiLetter(segments[0][0]) ||
            segments[0][1] != ':')
        {
            return null;
        }
        var builder = new StringBuilder("file:///").Append(segments[0]);
        for (var index = 1; index < segments.Length; index++)
        {
            if (segments[index].Length == 0)
            {
                return null;
            }
            builder.Append('/').Append(Uri.EscapeDataString(segments[index]));
        }
        return builder.ToString();
    }

    public static (string Kind, int Index) ParseActivationArguments(string arguments)
    {
        var (kind, index) = ("click", -1);
        foreach (var pair in arguments.Split(';'))
        {
            var separator = pair.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }
            var value = pair[(separator + 1)..];
            switch (pair[..separator])
            {
                case "kind" when value is "click" or "action": kind = value; break;
                case "index": _ = int.TryParse(value, out index); break;
            }
        }
        return (kind, kind == "action" ? index : -1);
    }

    /// <summary>One outbound `notifications/event` JSON-RPC frame.</summary>
    public static string BuildEventFrame(string token, string kind, int actionIndex) =>
        JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = EventMethod,
            @params = actionIndex >= 0
                ? (object)new { token, kind, actionIndex }
                : new { token, kind },
        });

    private async ValueTask<ShowResponse> Deliver(ShowRequest request)
    {
        try
        {
            EnsureAppIdRegistered();
            var notifier = ToastNotificationManager.CreateToastNotifier(AppUserModelId);
            if (notifier.Setting != NotificationSetting.Enabled)
            {
                return new ShowResponse(false, $"Notifications are disabled: {notifier.Setting}");
            }
            var xml = new XmlDocument();
            xml.LoadXml(BuildToastXml(request));
            var toast = new ToastNotification(xml);
            var failure = new TaskCompletionSource<string>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            toast.Activated += (_, args) => OnActivated(request.Token, args);
            toast.Dismissed += (_, _) => Untrack(request.Token);
            toast.Failed += (_, args) =>
            {
                Untrack(request.Token);
                failure.TrySetResult(args.ErrorCode?.Message ?? "Toast delivery failed");
            };
            Track(request.Token, toast);
            notifier.Show(toast);
            var completed = await Task.WhenAny(failure.Task, Task.Delay(FailedEventGraceMs));
            return completed == failure.Task
                ? new ShowResponse(false, await failure.Task)
                : new ShowResponse(true, null);
        }
        catch (Exception exception)
        {
            Untrack(request.Token);
            return new ShowResponse(false, exception.Message);
        }
    }

    /// <summary>An unpackaged app can only post toasts under a registered
    /// AppUserModelId; the per-user classes key is the documented no-installer
    /// registration. Installed builds can replace it with a shortcut-based one.</summary>
    private static void EnsureAppIdRegistered()
    {
        if (_appIdRegistered)
        {
            return;
        }
        _appIdRegistered = true;
        using var key = Registry.CurrentUser.CreateSubKey(
            $@"Software\Classes\AppUserModelId\{AppUserModelId}");
        key.SetValue("DisplayName", "Vellum");
    }

    private void OnActivated(string token, object args)
    {
        var arguments = (args as ToastActivatedEventArgs)?.Arguments ?? string.Empty;
        var (kind, index) = ParseActivationArguments(arguments);
        Console.Out.WriteLine(BuildEventFrame(token, kind, index));
    }

    private void Track(string token, ToastNotification toast)
    {
        lock (_gate)
        {
            if (_liveToasts.Count >= MaxTrackedToasts)
            {
                _liveToasts.Remove(_liveToasts.Keys.First());
            }
            _liveToasts[token] = toast;
        }
    }

    private void Untrack(string token)
    {
        lock (_gate)
        {
            _liveToasts.Remove(token);
        }
    }
}
