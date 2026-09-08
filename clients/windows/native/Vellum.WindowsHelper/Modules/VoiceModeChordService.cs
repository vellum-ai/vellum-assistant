using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

public sealed class VoiceModeChordService : IRpcModule, IDisposable
{
    public const string SetMethod = "hotkey.setVoiceModeChord";
    public const string EventMethod = "hotkey.voiceModeChord";

    private readonly object _gate = new();
    private readonly ChordTapTracker _tracker = new();
    private readonly Channel<string> _events = Channel.CreateUnbounded<string>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    private readonly Task _outputTask;
    private GlobalKeyboardHook? _hook;

    public VoiceModeChordService()
    {
        _outputTask = DrainEventsAsync();
    }

    public IReadOnlyCollection<string> Methods { get; } = [SetMethod];

    public ValueTask<object?> InvokeAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken)
    {
        if (method != SetMethod)
        {
            throw new RpcMethodNotFoundException(method);
        }
        if (!TryPlanChord(parameters, out var keys, out var reason))
        {
            Disable();
            return ValueTask.FromResult<object?>(new SetResponse(false, false, reason));
        }

        var enabled = keys.Count > 0;
        if (enabled && !EnsureHook(out reason))
        {
            return ValueTask.FromResult<object?>(new SetResponse(false, false, reason));
        }

        lock (_gate)
        {
            _tracker.Configure(keys);
        }
        if (!enabled)
        {
            StopHook();
        }
        return ValueTask.FromResult<object?>(new SetResponse(true, enabled, null));
    }

    public void Dispose()
    {
        Disable();
        _events.Writer.TryComplete();
        try
        {
            _outputTask.GetAwaiter().GetResult();
        }
        catch (IOException)
        {
        }
    }

    private void Disable()
    {
        lock (_gate)
        {
            _tracker.Configure([]);
        }
        StopHook();
    }

    private bool EnsureHook(out string reason)
    {
        if (_hook is not null)
        {
            reason = string.Empty;
            return true;
        }
        var hook = new GlobalKeyboardHook(OnKeyboardEvent);
        if (!hook.Start(out reason))
        {
            hook.Dispose();
            return false;
        }
        _hook = hook;
        return true;
    }

    private void StopHook()
    {
        var hook = Interlocked.Exchange(ref _hook, null);
        hook?.Dispose();
    }

    private void OnKeyboardEvent(ushort key, bool down)
    {
        bool tap;
        lock (_gate)
        {
            if (down)
            {
                _tracker.KeyDown(key);
                tap = false;
            }
            else
            {
                tap = _tracker.KeyUp(key);
            }
        }
        if (!tap)
        {
            return;
        }
        // A completed tap is reported as a down/up pair once the keys are
        // back up; the renderer toggles on the down edge.
        _events.Writer.TryWrite("down");
        _events.Writer.TryWrite("up");
    }

    private async Task DrainEventsAsync()
    {
        // `Console.Out` is synchronized, so each frame lands on stdout as one
        // uninterleaved line alongside response and notification frames. The
        // channel exists for the hook thread: a low-level keyboard callback
        // must never block on I/O, so it only enqueues and this task writes.
        await foreach (var state in _events.Reader.ReadAllAsync())
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(new
            {
                jsonrpc = "2.0",
                method = EventMethod,
                @params = new { state },
            }));
            Console.Out.Flush();
        }
    }

    private static bool TryPlanChord(
        JsonElement? parameters,
        out IReadOnlyList<ushort> keys,
        out string reason)
    {
        keys = [];
        reason = "Invalid voice mode chord binding";
        RawRequest? request;
        try
        {
            request = parameters?.Deserialize<RawRequest>(JsonOptions);
        }
        catch (JsonException)
        {
            return false;
        }
        if (request?.Activator is null || request.Activator.Kind == "off")
        {
            reason = string.Empty;
            return true;
        }
        if (request.Activator.Kind != "modifierOnly")
        {
            reason = "The voice mode chord supports modifier-only bindings";
            return false;
        }

        try
        {
            if (request.Activator.Modifiers is null)
            {
                return false;
            }
            var planned = request.Activator.Modifiers
                .Select(ResolveModifier)
                .ToList();
            if (planned.Count == 0 || planned.Distinct().Count() != planned.Count)
            {
                return false;
            }
            keys = planned;
            reason = string.Empty;
            return true;
        }
        catch (ArgumentException exception)
        {
            reason = exception.Message;
            return false;
        }
    }

    private static ushort ResolveModifier(string modifier) =>
        modifier.Equals("function", StringComparison.OrdinalIgnoreCase)
            ? throw new ArgumentException("Fn is unavailable on Windows")
            : KeyPlanner.ResolveModifier(modifier, commandAsWindowsKey: true);

    private static readonly JsonSerializerOptions JsonOptions =
        new() { PropertyNameCaseInsensitive = true };

    private sealed record RawRequest(RawActivator? Activator);
    private sealed record RawActivator(string Kind, List<string>? Modifiers);
    private sealed record SetResponse(
        [property: JsonPropertyName("ok")] bool Ok,
        [property: JsonPropertyName("enabled")] bool Enabled,
        [property: JsonPropertyName("reason")]
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        string? Reason);
}

internal sealed partial class GlobalKeyboardHook : IDisposable
{
    private const int KeyboardHook = 13;
    private const uint KeyDown = 0x0100;
    private const uint KeyUp = 0x0101;
    private const uint SystemKeyDown = 0x0104;
    private const uint SystemKeyUp = 0x0105;
    private const uint Quit = 0x0012;
    private const uint Injected = 0x10;

    private readonly Action<ushort, bool> _onKey;
    private readonly HookProc _callback;
    private readonly PhysicalKeyTracker _physicalKeys = new();
    private Thread? _thread;
    private uint _threadId;
    private nint _hook;
    private string? _startError;

    public GlobalKeyboardHook(Action<ushort, bool> onKey)
    {
        _onKey = onKey;
        _callback = HookCallback;
    }

    public bool Start(out string reason)
    {
        using var started = new ManualResetEventSlim();
        _thread = new Thread(() => Run(started))
        {
            IsBackground = true,
            Name = "Vellum voice mode chord hook",
        };
        _thread.Start();
        started.Wait();
        reason = _startError ?? string.Empty;
        return _hook != 0;
    }

    public void Dispose()
    {
        if (_threadId != 0)
        {
            _ = PostThreadMessage(_threadId, Quit, 0, 0);
        }
        if (_thread is { } thread && thread != Thread.CurrentThread)
        {
            thread.Join();
        }
        _thread = null;
    }

    private void Run(ManualResetEventSlim started)
    {
        _threadId = GetCurrentThreadId();
        _hook = SetWindowsHookEx(KeyboardHook, _callback, GetModuleHandle(null), 0);
        if (_hook == 0)
        {
            _startError = $"Keyboard hook failed ({Marshal.GetLastWin32Error()})";
        }
        started.Set();
        if (_hook == 0)
        {
            return;
        }
        while (GetMessage(out var message, 0, 0, 0) > 0)
        {
            TranslateMessage(in message);
            DispatchMessage(in message);
        }
        _ = UnhookWindowsHookEx(_hook);
        _hook = 0;
        _threadId = 0;
    }

    private nint HookCallback(int code, nuint message, nint data)
    {
        if (code >= 0)
        {
            var input = Marshal.PtrToStructure<LowLevelKeyboardInput>(data);
            if ((input.Flags & Injected) == 0)
            {
                var down = message is KeyDown or SystemKeyDown;
                var up = message is KeyUp or SystemKeyUp;
                if (down || up)
                {
                    ForwardPhysicalKey((ushort)input.VirtualKey, down);
                }
            }
        }
        return CallNextHookEx(_hook, code, message, data);
    }

    private void ForwardPhysicalKey(ushort physicalKey, bool down)
    {
        if (_physicalKeys.Observe(physicalKey, down) is { } transition)
        {
            _onKey(transition.Key, transition.Down);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LowLevelKeyboardInput
    {
        public uint VirtualKey;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public nuint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public nint Window;
        public uint Value;
        public nuint WParam;
        public nint LParam;
        public uint Time;
        public int PointX;
        public int PointY;
        public uint Private;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint HookProc(int code, nuint message, nint data);

    [LibraryImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    private static partial nint SetWindowsHookEx(int id, HookProc callback, nint module, uint threadId);
    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool UnhookWindowsHookEx(nint hook);
    [LibraryImport("user32.dll")]
    private static partial nint CallNextHookEx(nint hook, int code, nuint message, nint data);
    [LibraryImport("user32.dll", EntryPoint = "GetMessageW")]
    private static partial int GetMessage(out Message message, nint window, uint min, uint max);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool TranslateMessage(in Message message);
    [LibraryImport("user32.dll", EntryPoint = "DispatchMessageW")]
    private static partial nint DispatchMessage(in Message message);
    [LibraryImport("user32.dll", EntryPoint = "PostThreadMessageW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool PostThreadMessage(uint threadId, uint message, nuint wParam, nint lParam);
    [LibraryImport("kernel32.dll")]
    private static partial uint GetCurrentThreadId();
    [LibraryImport("kernel32.dll", EntryPoint = "GetModuleHandleW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint GetModuleHandle(string? moduleName);
}
