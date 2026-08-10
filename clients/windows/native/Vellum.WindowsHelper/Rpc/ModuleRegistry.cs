using System.Reflection;
using System.Text.Json;

namespace Vellum.WindowsHelper.Rpc;

public sealed class ModuleRegistry
{
    private const int ParseError = -32700;
    private const int InvalidRequest = -32600;
    private const int MethodNotFound = -32601;
    private const int InternalError = -32603;
    private readonly Dictionary<string, IRpcModule> _modulesByMethod;

    public ModuleRegistry(IEnumerable<IRpcModule> modules)
    {
        _modulesByMethod = new Dictionary<string, IRpcModule>(StringComparer.Ordinal);
        foreach (var module in modules)
        {
            foreach (var method in module.Methods)
            {
                if (string.IsNullOrWhiteSpace(method))
                {
                    throw new InvalidOperationException("RPC methods must have a name");
                }
                if (!_modulesByMethod.TryAdd(method, module))
                {
                    throw new InvalidOperationException($"Duplicate RPC method: {method}");
                }
            }
        }
    }

    public static ModuleRegistry Discover(params Assembly[] assemblies)
    {
        var modules = assemblies
            .SelectMany(assembly => assembly.GetTypes())
            .Where(type =>
                !type.IsAbstract &&
                !type.IsInterface &&
                typeof(IRpcModule).IsAssignableFrom(type))
            .Select(type => (IRpcModule)Activator.CreateInstance(type, nonPublic: true)!);
        return new ModuleRegistry(modules);
    }

    public async ValueTask<string?> ProcessFrameAsync(
        string frame,
        CancellationToken cancellationToken)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(frame);
        }
        catch (JsonException)
        {
            return Error(null, ParseError, "Parse error");
        }

        using (document)
        {
            var request = document.RootElement;
            if (!TryReadRequest(request, out var method, out var id, out var hasId))
            {
                return Error(null, InvalidRequest, "Invalid Request");
            }

            try
            {
                var parameters = request.TryGetProperty("params", out var value)
                    ? value
                    : (JsonElement?)null;
                var result = await DispatchAsync(method, parameters, cancellationToken);
                return hasId ? Success(id, result) : null;
            }
            catch (RpcMethodNotFoundException)
            {
                return hasId ? Error(id, MethodNotFound, "Method not found") : null;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                return hasId ? Error(id, InternalError, "Internal error") : null;
            }
        }
    }

    public ValueTask<object?> DispatchAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken)
    {
        if (!_modulesByMethod.TryGetValue(method, out var module))
        {
            throw new RpcMethodNotFoundException(method);
        }
        return module.InvokeAsync(method, parameters, cancellationToken);
    }

    private static bool TryReadRequest(
        JsonElement request,
        out string method,
        out JsonElement id,
        out bool hasId)
    {
        method = string.Empty;
        id = default;
        hasId = false;
        if (request.ValueKind != JsonValueKind.Object ||
            !request.TryGetProperty("jsonrpc", out var version) ||
            version.ValueKind != JsonValueKind.String ||
            version.GetString() != "2.0" ||
            !request.TryGetProperty("method", out var methodElement) ||
            methodElement.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        method = methodElement.GetString()!;
        if (method.Length == 0)
        {
            return false;
        }
        hasId = request.TryGetProperty("id", out id);
        return !hasId || id.ValueKind is
            JsonValueKind.String or JsonValueKind.Number or JsonValueKind.Null;
    }

    private static string Success(JsonElement id, object? result) =>
        JsonSerializer.Serialize(new { jsonrpc = "2.0", id, result });

    private static string Error(JsonElement? id, int code, string message) =>
        JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id,
            error = new { code, message },
        });
}

public sealed class RpcMethodNotFoundException(string method)
    : Exception($"RPC method is not registered: {method}");
