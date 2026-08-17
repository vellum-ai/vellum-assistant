using Vellum.WindowsHelper.Modules;

public static class TextInsertionTests
{
    public static async Task RunAsync()
    {
        await ProtectedFieldIsRefusedAsync();
        await UnknownFocusIsRefusedAsync();
        await UnavailableClipboardIsBlockedAsync();
        await FailedClipboardWriteRestoresSnapshotAsync();
        await PasteRestoresClipboardWhenStillHoldingInsertedTextAsync();
        await PasteLeavesClipboardWhenTargetReplacedItAsync();
        await FailedPasteRestoresClipboardAndBlocksAsync();
        PermissionMappings();
        Console.WriteLine("Text insertion tests passed");
    }

    private static async Task ProtectedFieldIsRefusedAsync()
    {
        var host = new FakeHost { ProtectedField = true };
        var outcome = await new TextInsertion(host).InsertAsync("secret", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "protected-field");
        Assert(host.WrittenTexts.Count == 0);
    }

    private static async Task UnknownFocusIsRefusedAsync()
    {
        var host = new FakeHost { ProtectedField = null };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "focus-unknown");
    }

    private static async Task UnavailableClipboardIsBlockedAsync()
    {
        var host = new FakeHost { Snapshot = null };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "clipboard-unavailable");
    }

    private static async Task FailedClipboardWriteRestoresSnapshotAsync()
    {
        var host = new FakeHost { WriteSucceeds = false };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "clipboard-unavailable");
        Assert(host.RestoredSnapshots.Count == 1);
    }

    private static async Task PasteRestoresClipboardWhenStillHoldingInsertedTextAsync()
    {
        var snapshot = new ClipboardSnapshot([new ClipboardEntry(13, [1, 2])]);
        var host = new FakeHost { Snapshot = snapshot };
        var outcome = await new TextInsertion(host).InsertAsync("héllo 🙂", CancellationToken.None);
        Assert(outcome.Status == "inserted");
        Assert(host.WrittenTexts is ["héllo 🙂"]);
        Assert(host.RestoredSnapshots is [var restored] && restored == snapshot);
    }

    private static async Task PasteLeavesClipboardWhenTargetReplacedItAsync()
    {
        var host = new FakeHost { ClipboardTextAfterPaste = "the target app copied this" };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "inserted");
        Assert(host.RestoredSnapshots.Count == 0);
    }

    private static async Task FailedPasteRestoresClipboardAndBlocksAsync()
    {
        var host = new FakeHost { PasteSucceeds = false };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "paste-failed");
        Assert(host.RestoredSnapshots.Count == 1);
    }

    private static void PermissionMappings()
    {
        Assert(PermissionService.MapMicrophoneConsent("Allow", "Allow") == "granted");
        Assert(PermissionService.MapMicrophoneConsent("Allow", "Deny") == "denied");
        Assert(PermissionService.MapOnlineSpeech(1) == "granted");
        Assert(PermissionService.MapOnlineSpeech(0) == "denied");
        Assert(PermissionService.MapOnlineSpeech(null) == "not-determined");
        Assert(PermissionService.MapToastEnabled(0) == "denied");
        Assert(PermissionService.MapToastEnabled(null) == "granted");
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("Text insertion assertion failed");
        }
    }

    private sealed class FakeHost : ITextInsertionHost
    {
        public bool? ProtectedField { get; init; } = false;
        public ClipboardSnapshot? Snapshot { get; init; } = new([]);
        public bool PasteSucceeds { get; init; } = true;
        public bool WriteSucceeds { get; init; } = true;
        public string? ClipboardTextAfterPaste { get; init; }
        public List<string> WrittenTexts { get; } = [];
        public List<ClipboardSnapshot> RestoredSnapshots { get; } = [];

        public bool? IsFocusedFieldProtected() => ProtectedField;

        public ClipboardSnapshot? SnapshotClipboard() => Snapshot;

        public void RestoreClipboard(ClipboardSnapshot snapshot) =>
            RestoredSnapshots.Add(snapshot);

        public bool WriteClipboardText(string text)
        {
            WrittenTexts.Add(text);
            return WriteSucceeds;
        }

        public string? ReadClipboardText() =>
            ClipboardTextAfterPaste ?? WrittenTexts.LastOrDefault();

        public bool SendPasteChord() => PasteSucceeds;

        public Task DelayAsync(int milliseconds, CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }
}
