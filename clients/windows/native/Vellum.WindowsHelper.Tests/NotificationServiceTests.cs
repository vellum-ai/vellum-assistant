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

        var xml = NotificationService.BuildToastXml(request);
        Assert(xml.Contains("<text>Ti&lt;tle</text>", StringComparison.Ordinal));
        Assert(xml.Contains("<text>B&amp;ody</text>", StringComparison.Ordinal));
        Assert(xml.Contains("content=\"Allow\"", StringComparison.Ordinal));
        Assert(xml.Contains("launch=\"kind=click\"", StringComparison.Ordinal));
        Assert(xml.Contains("arguments=\"kind=action;index=1\"", StringComparison.Ordinal));

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

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("NotificationService assertion failed");
        }
    }
}
