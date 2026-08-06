using System.Text.Json;

namespace Vellum.WindowsHelper.Rpc;

public interface INativeCapability
{
    string CapabilityId { get; }
}

public interface IInputController : INativeCapability
{
}

public interface ITextInsertionSink : INativeCapability
{
}

public interface IDictationSink : INativeCapability
{
}

public interface INotificationAdapter : INativeCapability
{
}

public interface IRpcModule
{
    IReadOnlyCollection<string> Methods { get; }

    ValueTask<object?> InvokeAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken);
}
