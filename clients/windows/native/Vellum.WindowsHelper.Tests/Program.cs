using System.Reflection;
using System.Text.Json;
using Vellum.WindowsHelper.Rpc;

var registry = ModuleRegistry.Discover(Assembly.GetExecutingAssembly());
var result = await registry.ProcessFrameAsync(
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"test.echo\",\"params\":{\"value\":\"hello\"}}",
    CancellationToken.None);
Assert(result is not null && result.Contains("\"hello\"", StringComparison.Ordinal));

var malformed = await registry.ProcessFrameAsync("not-json", CancellationToken.None);
Assert(malformed is not null && malformed.Contains("-32700", StringComparison.Ordinal));

var invalid = await registry.ProcessFrameAsync(
    "{\"jsonrpc\":2,\"id\":1,\"method\":\"test.echo\"}",
    CancellationToken.None);
Assert(invalid is not null && invalid.Contains("-32600", StringComparison.Ordinal));

var missing = await registry.ProcessFrameAsync(
    "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"missing\"}",
    CancellationToken.None);
Assert(missing is not null && missing.Contains("-32601", StringComparison.Ordinal));

var notification = await registry.ProcessFrameAsync(
    "{\"jsonrpc\":\"2.0\",\"method\":\"test.echo\"}",
    CancellationToken.None);
Assert(notification is null);

try
{
    _ = new ModuleRegistry([new EchoModule(), new EchoModule()]);
    throw new Exception("Duplicate methods were accepted");
}
catch (InvalidOperationException)
{
}

try
{
    _ = new ModuleRegistry([new EchoModule { Methods = [""] }]);
    throw new Exception("Blank methods were accepted");
}
catch (InvalidOperationException)
{
}

Console.WriteLine("Native helper registry tests passed");

DictationServiceTests.Run();
await Vellum.WindowsHelper.Tests.AutomationObserverTests.RunAsync();
await Vellum.WindowsHelper.Tests.ScreenCaptureTests.RunAsync();
await Vellum.WindowsHelper.Tests.InputControllerTests.RunAsync();
await TextInsertionTests.RunAsync();
await NotificationServiceTests.RunAsync();
await Vellum.WindowsHelper.Tests.WindowsCuObservationSourceTests.RunAsync();

static void Assert(bool condition)
{
    if (!condition)
    {
        throw new Exception("Native helper registry assertion failed");
    }
}

public sealed class EchoModule : IRpcModule
{
    public IReadOnlyCollection<string> Methods { get; init; } = ["test.echo"];

    public ValueTask<object?> InvokeAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken) =>
        ValueTask.FromResult<object?>(parameters);
}
