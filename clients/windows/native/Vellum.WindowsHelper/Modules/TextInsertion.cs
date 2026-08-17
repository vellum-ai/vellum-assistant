using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

public sealed record InsertionOutcome(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("reason")] string? Reason = null);

/// <summary>Raw clipboard contents, one entry per preservable format.</summary>
public sealed record ClipboardSnapshot(IReadOnlyList<ClipboardEntry> Entries)
{
    public static readonly ClipboardSnapshot Empty = new([]);
}

public sealed record ClipboardEntry(uint Format, byte[] Bytes);

/// <summary>
/// OS seam so insertion behavior is testable with fakes. Failures surface
/// as null or false results rather than exceptions.
/// </summary>
public interface ITextInsertionHost
{
    /// <summary>Null when the focused field cannot be read at all.</summary>
    bool? IsFocusedFieldProtected();
    ClipboardSnapshot SnapshotClipboard();
    void RestoreClipboard(ClipboardSnapshot snapshot);
    bool WriteClipboardText(string text);
    string? ReadClipboardText();
    bool SendPasteChord();
    Task DelayAsync(int milliseconds, CancellationToken cancellationToken);
}

/// <summary>
/// Inserts assistant text into the focused control of the foreground app,
/// matching the macOS behavior: snapshot the clipboard, write the text,
/// send a paste chord, and restore the snapshot only when the clipboard
/// still holds the inserted text. UI Automation is the Windows safety
/// adaptation: password fields, and fields whose state cannot be read
/// (elevated targets), are refused before anything is written.
/// </summary>
public sealed class TextInsertion(ITextInsertionHost host) : IRpcModule, ITextInsertionSink
{
    public const string InsertMethod = "text.insert";
    private const int ClipboardRestoreDelayMs = 500;

    private readonly ITextInsertionHost _host = host;

    public TextInsertion()
        : this(new Win32TextInsertionHost())
    {
    }

    public string CapabilityId => "textInsertion";

    public IReadOnlyCollection<string> Methods { get; } = [InsertMethod];

    public async ValueTask<object?> InvokeAsync(
        string method,
        JsonElement? parameters,
        CancellationToken cancellationToken)
    {
        var text =
            parameters is { ValueKind: JsonValueKind.Object } request &&
            request.TryGetProperty("text", out var textElement) &&
            textElement.ValueKind == JsonValueKind.String
                ? textElement.GetString()
                : null;
        return string.IsNullOrEmpty(text)
            ? new InsertionOutcome("blocked", "missing-text")
            : await InsertAsync(text, cancellationToken);
    }

    public async Task<InsertionOutcome> InsertAsync(
        string text,
        CancellationToken cancellationToken)
    {
        var isProtected = _host.IsFocusedFieldProtected();
        if (isProtected is null)
        {
            // An unreadable focus target (no focus, or an elevated or
            // protected process) is never written into.
            return new InsertionOutcome("blocked", "focus-unknown");
        }
        if (isProtected.Value)
        {
            return new InsertionOutcome("blocked", "protected-field");
        }

        var snapshot = _host.SnapshotClipboard();
        if (!_host.WriteClipboardText(text))
        {
            return new InsertionOutcome("blocked", "clipboard-unavailable");
        }

        if (!_host.SendPasteChord())
        {
            _host.RestoreClipboard(snapshot);
            return new InsertionOutcome("blocked", "paste-failed");
        }

        await _host.DelayAsync(ClipboardRestoreDelayMs, cancellationToken);
        if (_host.ReadClipboardText() == text)
        {
            _host.RestoreClipboard(snapshot);
        }
        return new InsertionOutcome("inserted");
    }
}

internal sealed class Win32TextInsertionHost : ITextInsertionHost
{
    private const uint CfUnicodeText = 13;
    private const uint GmemMoveable = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkV = 0x56;
    private const int ClipboardOpenAttempts = 10;
    private const int ClipboardOpenRetryDelayMs = 30;

    // Handle-based and owner-rendered formats cannot be copied as bytes.
    private static readonly uint[] SkippedFormats = [2, 3, 14, 0x0080, 0x0082, 0x0083, 0x008E];

    public bool? IsFocusedFieldProtected()
    {
        try
        {
            return AutomationElement.FocusedElement?.Current.IsPassword;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public ClipboardSnapshot SnapshotClipboard()
    {
        if (!OpenClipboardWithRetry())
        {
            return ClipboardSnapshot.Empty;
        }
        try
        {
            var entries = new List<ClipboardEntry>();
            uint format = 0;
            while ((format = EnumClipboardFormats(format)) != 0)
            {
                if (!IsPreservableFormat(format))
                {
                    continue;
                }
                var handle = GetClipboardData(format);
                if (handle == IntPtr.Zero)
                {
                    continue;
                }
                var bytes = CopyGlobalBytes(handle);
                if (bytes is not null)
                {
                    entries.Add(new ClipboardEntry(format, bytes));
                }
            }
            return new ClipboardSnapshot(entries);
        }
        finally
        {
            _ = CloseClipboard();
        }
    }

    public void RestoreClipboard(ClipboardSnapshot snapshot) =>
        _ = SetClipboardEntries(snapshot.Entries);

    public bool WriteClipboardText(string text)
    {
        var bytes = new byte[(text.Length + 1) * 2];
        System.Text.Encoding.Unicode.GetBytes(text, 0, text.Length, bytes, 0);
        return SetClipboardEntries([new ClipboardEntry(CfUnicodeText, bytes)]);
    }

    private static bool SetClipboardEntries(IReadOnlyList<ClipboardEntry> entries)
    {
        if (!OpenClipboardWithRetry())
        {
            return false;
        }
        try
        {
            _ = EmptyClipboard();
            var allSet = true;
            foreach (var entry in entries)
            {
                var handle = AllocGlobalBytes(entry.Bytes);
                if (handle == IntPtr.Zero)
                {
                    allSet = false;
                }
                else if (SetClipboardData(entry.Format, handle) == IntPtr.Zero)
                {
                    _ = GlobalFree(handle);
                    allSet = false;
                }
            }
            return allSet;
        }
        finally
        {
            _ = CloseClipboard();
        }
    }

    public string? ReadClipboardText()
    {
        if (!OpenClipboardWithRetry())
        {
            return null;
        }
        try
        {
            var handle = GetClipboardData(CfUnicodeText);
            var bytes = handle == IntPtr.Zero ? null : CopyGlobalBytes(handle);
            if (bytes is null)
            {
                return null;
            }
            var text = System.Text.Encoding.Unicode.GetString(bytes);
            var terminator = text.IndexOf('\0');
            return terminator < 0 ? text : text[..terminator];
        }
        finally
        {
            _ = CloseClipboard();
        }
    }

    public bool SendPasteChord()
    {
        var inputs = new[]
        {
            KeyInput(VkControl, keyUp: false),
            KeyInput(VkV, keyUp: false),
            KeyInput(VkV, keyUp: true),
            KeyInput(VkControl, keyUp: true),
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) ==
            (uint)inputs.Length;
    }

    public Task DelayAsync(int milliseconds, CancellationToken cancellationToken) =>
        Task.Delay(milliseconds, cancellationToken);

    private static bool IsPreservableFormat(uint format) =>
        !SkippedFormats.Contains(format) &&
        format is not (>= 0x0200 and < 0x0400);

    private static bool OpenClipboardWithRetry()
    {
        for (var attempt = 0; attempt < ClipboardOpenAttempts; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero))
            {
                return true;
            }
            Thread.Sleep(ClipboardOpenRetryDelayMs);
        }
        return false;
    }

    private static byte[]? CopyGlobalBytes(IntPtr handle)
    {
        var size = (int)GlobalSize(handle);
        if (size <= 0)
        {
            return null;
        }
        var pointer = GlobalLock(handle);
        if (pointer == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            var bytes = new byte[size];
            Marshal.Copy(pointer, bytes, 0, size);
            return bytes;
        }
        finally
        {
            _ = GlobalUnlock(handle);
        }
    }

    private static IntPtr AllocGlobalBytes(byte[] bytes)
    {
        var handle = GlobalAlloc(GmemMoveable, (nuint)bytes.Length);
        if (handle == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        var pointer = GlobalLock(handle);
        if (pointer == IntPtr.Zero)
        {
            _ = GlobalFree(handle);
            return IntPtr.Zero;
        }
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
        }
        finally
        {
            _ = GlobalUnlock(handle);
        }
        return handle;
    }

    private static Input KeyInput(ushort key, bool keyUp)
    {
        const uint inputKeyboard = 1;
        const uint keyEventKeyUp = 0x0002;
        return new Input
        {
            Type = inputKeyboard,
            Keyboard = new KeyboardInput { Vk = key, Flags = keyUp ? keyEventKeyUp : 0 },
        };
    }

    // Interop-only fields are written by object initializers or read by the
    // marshaller, never both; keep the unused-field warnings quiet. The
    // explicit layout matches 64-bit INPUT (both published RIDs are 64-bit):
    // the union starts at offset 8 and MOUSEINPUT sets the 40-byte size.
#pragma warning disable CS0169, CS0649
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    private struct Input
    {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(8)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Vk;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }
#pragma warning restore CS0169, CS0649

    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr newOwner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern nuint GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
}
