using System.Text.Json;
using Vellum.WindowsHelper.Modules;

public static class NotificationServiceTests
{
    public static async Task RunAsync()
    {
        using var valid = JsonDocument.Parse(
            """{ "token": "t-1", "title": "Ti<tle", "body": "B&ody", "actions": [{ "text": "Allow" }, { "text": "Deny" }] }""");
        Assert(NotificationService.TryParseShowRequest(valid.RootElement, out var request, out _));
        Assert(request.Actions.Count == 2);

        Assert(request.Subtitle is null && request.AvatarPath is null);

        var xml = NotificationService.BuildToastXml(request);
        // Without a sender: title then body, and no app-logo image.
        Assert(xml.Contains("<text>Ti&lt;tle</text><text>B&amp;ody</text>", StringComparison.Ordinal));
        Assert(!xml.Contains("<image", StringComparison.Ordinal));
        Assert(xml.Contains("content=\"Allow\"", StringComparison.Ordinal));
        Assert(xml.Contains("launch=\"kind=click\"", StringComparison.Ordinal));
        Assert(xml.Contains("arguments=\"kind=action;index=1\"", StringComparison.Ordinal));

        using var withSender = JsonDocument.Parse(
            """{ "token": "t-2", "title": "Aria", "subtitle": "Ti<tle", "body": "B&ody", "actions": [], "avatarPath": "C:\\Users\\test\\Vellum Data\\a&b.png" }""");
        Assert(NotificationService.TryParseShowRequest(withSender.RootElement, out var senderRequest, out _));
        Assert(senderRequest is { Subtitle: "Ti<tle", AvatarPath: "C:\\Users\\test\\Vellum Data\\a&b.png" });

        var senderXml = NotificationService.BuildToastXml(senderRequest);
        // Assistant name, conversation title, body, in that order.
        Assert(senderXml.Contains(
            "<text>Aria</text><text>Ti&lt;tle</text><text>B&amp;ody</text>",
            StringComparison.Ordinal));
        Assert(senderXml.Contains(
            "<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"file:///C:/Users/test/Vellum%20Data/",
            StringComparison.Ordinal));
        // The image sits inside the binding, and no raw ampersand reaches the XML.
        Assert(senderXml.Contains("/></binding></visual>", StringComparison.Ordinal));
        Assert(!senderXml.Contains("&b.png", StringComparison.Ordinal));

        // A blank subtitle is the same as none, and a path a toast cannot load
        // drops the image rather than emitting a broken src.
        using var blankExtras = JsonDocument.Parse(
            """{ "token": "t-3", "title": "T", "subtitle": "", "body": "B", "actions": [], "avatarPath": "notification-avatars/a.png" }""");
        Assert(NotificationService.TryParseShowRequest(blankExtras.RootElement, out var blankRequest, out _));
        Assert(blankRequest.Subtitle is null);
        var blankXml = NotificationService.BuildToastXml(blankRequest);
        Assert(blankXml.Contains("<text>T</text><text>B</text>", StringComparison.Ordinal));
        Assert(!blankXml.Contains("<image", StringComparison.Ordinal));

        // The src is built from the path's own segments, so a literal percent
        // sequence in a folder name stays encoded instead of decoding to a
        // different file.
        Assert(AvatarImageSrc(@"C:\Users\%20\a.png") == "file:///C:/Users/%2520/a.png");
        // Spaces and reserved characters are percent-encoded, not passed through.
        Assert(AvatarImageSrc(@"C:\Vellum Data\a&b.png") == "file:///C:/Vellum%20Data/a%26b.png");
        // A path with no drive root is not something a toast can load.
        Assert(AvatarImageSrc(@"notification-avatars\a.png") is null);

        Assert(NotificationService.ParseActivationArguments("kind=action;index=1") == ("action", 1));
        // Unreadable arguments still route as a body click.
        Assert(NotificationService.ParseActivationArguments("garbage") == ("click", -1));

        var clickFrame = NotificationService.BuildEventFrame("t-1", "click", -1);
        Assert(clickFrame.Contains("\"method\":\"notifications/event\"", StringComparison.Ordinal));
        Assert(clickFrame.Contains("\"token\":\"t-1\"", StringComparison.Ordinal));
        Assert(!clickFrame.Contains("actionIndex", StringComparison.Ordinal));
        Assert(NotificationService.BuildEventFrame("t-1", "action", 0)
            .Contains("\"actionIndex\":0", StringComparison.Ordinal));

        // The ack the Electron shell parses: lowercase keys, null error omitted.
        Assert(JsonSerializer.Serialize(new NotificationService.ShowResponse(true, null))
            == "{\"success\":true}");

        var delivered = 0;
        var service = new NotificationService(_ =>
        {
            delivered++;
            return ValueTask.FromResult(new NotificationService.ShowResponse(true, null));
        });
        using var missingFields = JsonDocument.Parse("{\"token\":\"x\"}");
        var invalidResult = await service.InvokeAsync(
            NotificationService.ShowMethod, missingFields.RootElement, CancellationToken.None);
        Assert(invalidResult is NotificationService.ShowResponse { Success: false } && delivered == 0);
        var okResult = await service.InvokeAsync(
            NotificationService.ShowMethod, valid.RootElement, CancellationToken.None);
        Assert(okResult is NotificationService.ShowResponse { Success: true } && delivered == 1);

        Console.WriteLine("NotificationService tests passed");
    }

    /// <summary>The app-logo image src the toast carries for an avatar path,
    /// or null when the toast drops the image.</summary>
    private static string? AvatarImageSrc(string avatarPath)
    {
        const string prefix =
            "<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"";
        var xml = NotificationService.BuildToastXml(
            new NotificationService.ShowRequest("t-src", "T", null, "B", [], avatarPath));
        var start = xml.IndexOf(prefix, StringComparison.Ordinal);
        if (start < 0)
        {
            return null;
        }
        var value = xml[(start + prefix.Length)..];
        return value[..value.IndexOf('"')];
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("NotificationService assertion failed");
        }
    }
}
