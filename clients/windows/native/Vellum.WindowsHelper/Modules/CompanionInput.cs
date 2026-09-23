using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Channels;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

public sealed class CompanionInput : IRpcModule, IDisposable
{
    private readonly Channel<object> _events = Channel.CreateBounded<object>(new BoundedChannelOptions(128)
    {
        SingleReader = true,
        FullMode = BoundedChannelFullMode.DropOldest,
    });
    private readonly Task _outputTask;
    private GlobalInputHook? _hook;

    public CompanionInput() => _outputTask = DrainEventsAsync();
    public IReadOnlyCollection<string> Methods { get; } = ["companion.watchInput"];

    public ValueTask<object?> InvokeAsync(string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        var enabled = parameters?.GetProperty("enabled").GetBoolean() == true;
        if (!enabled)
        {
            _hook?.Dispose();
            _hook = null;
        }
        else if (_hook is null)
        {
            var hook = new GlobalInputHook(14, "Vellum companion mouse hook", OnInput);
            if (!hook.Start(out var reason))
            {
                hook.Dispose();
                throw new InvalidOperationException(reason);
            }
            _hook = hook;
        }
        return ValueTask.FromResult<object?>(new { enabled });
    }

    private void OnInput(nuint message, nint data)
    {
        if (message is not (0x0201 or 0x020A or 0x020E))
        {
            return;
        }
        var input = Marshal.PtrToStructure<MouseInput>(data);
        if ((input.Flags & 1) != 0)
        {
            return;
        }
        _events.Writer.TryWrite(new { kind = message == 0x0201 ? "press" : "scroll", x = input.X, y = input.Y });
    }

    private async Task DrainEventsAsync()
    {
        await foreach (var value in _events.Reader.ReadAllAsync())
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(new { jsonrpc = "2.0", method = "companion.input", @params = value }));
            Console.Out.Flush();
        }
    }

    public void Dispose()
    {
        _hook?.Dispose();
        _events.Writer.TryComplete();
        try { _outputTask.GetAwaiter().GetResult(); }
        catch (IOException) { }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public nuint ExtraInfo;
    }
}
