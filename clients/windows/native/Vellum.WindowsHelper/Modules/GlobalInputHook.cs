using System.Runtime.InteropServices;

namespace Vellum.WindowsHelper.Modules;

internal sealed partial class GlobalInputHook : IDisposable
{
    private const uint Quit = 0x0012;

    private readonly Action<nuint, nint> _onInput;
    private readonly int _hookType;
    private readonly string _name;
    private readonly HookProc _callback;
    private Thread? _thread;
    private uint _threadId;
    private nint _hook;
    private string? _startError;

    public GlobalInputHook(int hookType, string name, Action<nuint, nint> onInput)
    {
        _hookType = hookType;
        _name = name;
        _onInput = onInput;
        _callback = HookCallback;
    }

    public bool Start(out string reason)
    {
        using var started = new ManualResetEventSlim();
        _thread = new Thread(() => Run(started))
        {
            IsBackground = true,
            Name = _name,
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
        _hook = SetWindowsHookEx(_hookType, _callback, GetModuleHandle(null), 0);
        if (_hook == 0)
        {
            _startError = $"Input hook failed ({Marshal.GetLastWin32Error()})";
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
            _onInput(message, data);
        }
        return CallNextHookEx(_hook, code, message, data);
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
