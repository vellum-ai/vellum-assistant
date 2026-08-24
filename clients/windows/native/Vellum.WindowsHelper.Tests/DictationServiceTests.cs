using Vellum.WindowsHelper.Modules;

/// <summary>
/// Behavior tests for the dictation session state machine, using fake
/// engines instead of System.Speech.
/// </summary>
public static class DictationServiceTests
{
    private sealed class FakeEngine : IDictationEngine
    {
        public string Tap => "fake";

        public bool Finished;
        public bool Cancelled;
        public bool Disposed;
        public bool FinalizeOnFinish = true;
        public TimeSpan? CompletionTimeout;
        public readonly List<byte[]> Chunks = [];
        public Exception? StartError;

        public event Action<string>? Partial;
        public event Action<string>? Finalized;
        public event Action<string>? Failed;

        public void Start()
        {
            if (StartError is not null)
            {
                throw StartError;
            }
        }

        public void Append(byte[] pcm) => Chunks.Add(pcm);

        public void Finish(TimeSpan completionTimeout)
        {
            Finished = true;
            CompletionTimeout = completionTimeout;
            if (FinalizeOnFinish)
            {
                Finalized?.Invoke("final text");
            }
        }

        public void Cancel() => Cancelled = true;

        public void Dispose() => Disposed = true;

        public void EmitPartial(string text) => Partial?.Invoke(text);

        public void EmitFailure(string message) => Failed?.Invoke(message);

        public void EmitFinalized(string text) => Finalized?.Invoke(text);
    }

    public static void Run()
    {
        var events = new List<(string Method, string Json)>();
        void Notify(string method, object parameters) =>
            events.Add((method, System.Text.Json.JsonSerializer.Serialize(parameters)));
        static string Json(object value) =>
            System.Text.Json.JsonSerializer.Serialize(value);

        // Unavailable engines (denied mic, missing language) refuse enablement.
        var denied = new DictationSessionManager(
            _ => throw new DictationUnavailableException("microphone access denied"),
            Notify);
        Assert(Json(denied.SetPartials(true, true, 16000))
            .Contains("microphone access denied", StringComparison.Ordinal));

        // Streaming session: start, partials, pushed audio, graceful stop.
        FakeEngine engine = new();
        var manager = new DictationSessionManager(_ => engine, Notify);
        Assert(Json(manager.SetPartials(true, true, 16000))
            .Contains("\"tap\":\"fake\"", StringComparison.Ordinal));
        engine.EmitPartial("hello");
        manager.AppendAudio(Convert.ToBase64String(new byte[] { 1, 2 }));
        Assert(engine.Chunks.Count == 1);
        manager.SetPartials(false, false, 16000);
        Assert(engine.Finished);
        Assert(events.Any(e => e.Method == "dictation.partial" &&
            e.Json.Contains("hello", StringComparison.Ordinal)));
        Assert(events.Any(e => e.Method == "dictation.finalized" &&
            e.Json.Contains("final text", StringComparison.Ordinal)));

        // Device loss mid-session surfaces dictation.error, not finalized.
        events.Clear();
        engine = new FakeEngine();
        Assert(Json(manager.SetPartials(true, false, 16000))
            .Contains("\"enabled\":true", StringComparison.Ordinal));
        engine.EmitFailure("audio device lost");
        Assert(events.Any(e => e.Method == "dictation.error" &&
            e.Json.Contains("audio device lost", StringComparison.Ordinal)));
        Assert(!events.Any(e => e.Method == "dictation.finalized"));
        Assert(SpinWait.SpinUntil(() => engine.Disposed, TimeSpan.FromSeconds(1)));
        manager.AppendAudio(Convert.ToBase64String(new byte[] { 3, 4 }));
        Assert(engine.Chunks.Count == 0);

        // Restarting cancels the replaced session: it is torn down and its
        // late events are dropped without a finalized transcript.
        events.Clear();
        var first = engine = new FakeEngine();
        manager.SetPartials(true, true, 16000);
        engine = new FakeEngine();
        manager.SetPartials(true, true, 16000);
        Assert(first.Cancelled && first.Disposed);
        first.EmitPartial("stale");
        engine.EmitPartial("fresh");
        Assert(!events.Any(e => e.Json.Contains("stale", StringComparison.Ordinal)));
        Assert(events.Any(e => e.Json.Contains("fresh", StringComparison.Ordinal)));

        // A failed replacement reports a reason and settles the displaced owner.
        events.Clear();
        engine = new FakeEngine { StartError = new Exception("audio device unavailable") };
        Assert(Json(manager.SetPartials(true, false, 16000))
            .Contains("audio device unavailable", StringComparison.Ordinal));
        Assert(events.Any(e => e.Method == "dictation.error" &&
            e.Json.Contains("audio device unavailable", StringComparison.Ordinal)));

        // Whole-recording transcription uses an independent pushed-audio
        // engine, publishes its final text, and does not disturb streaming.
        events.Clear();
        var streaming = new FakeEngine();
        var oneShot = new FakeEngine();
        var engines = new Queue<FakeEngine>([streaming, oneShot]);
        manager = new DictationSessionManager(_ => engines.Dequeue(), Notify);
        manager.SetPartials(true, true, 16000);
        Assert(Json(manager.Transcribe(
            Convert.ToBase64String(new byte[] { 5, 6 }), 16000, "request-1"))
            .Contains("\"ok\":true", StringComparison.Ordinal));
        Assert(oneShot.Chunks.Count == 1 && oneShot.Finished);
        Assert(!streaming.Cancelled && !streaming.Disposed);
        Assert(events.Any(e => e.Method == "dictation.transcribed" &&
            e.Json.Contains("final text", StringComparison.Ordinal) &&
            e.Json.Contains("request-1", StringComparison.Ordinal)));

        // A newer one-shot request cancels the old request and suppresses
        // callbacks that arrive after replacement.
        events.Clear();
        var replaced = new FakeEngine { FinalizeOnFinish = false };
        var current = new FakeEngine();
        engines = new Queue<FakeEngine>([replaced, current]);
        manager = new DictationSessionManager(_ => engines.Dequeue(), Notify);
        manager.Transcribe(
            Convert.ToBase64String(new byte[] { 1 }), 16000, "request-1");
        manager.Transcribe(
            Convert.ToBase64String(new byte[] { 2 }), 16000, "request-2");
        Assert(replaced.Cancelled && replaced.Disposed);
        replaced.EmitFinalized("stale");
        Assert(events.Count(e => e.Method == "dictation.transcribed") == 1);
        Assert(!events.Any(e => e.Json.Contains("stale", StringComparison.Ordinal)));

        Assert(Json(manager.Transcribe("not-base64", 16000, "request-3"))
            .Contains("invalid audio", StringComparison.Ordinal));

        // The completion guard includes the submitted recording duration so
        // a long pushed buffer can drain before the fallback finalizes it.
        var oneMinutePcm = new byte[16000 * sizeof(short) * 60];
        var longRecordingEngine = new FakeEngine();
        manager = new DictationSessionManager(_ => longRecordingEngine, Notify);
        manager.Transcribe(
            Convert.ToBase64String(oneMinutePcm), 16000, "request-4");
        Assert(longRecordingEngine.CompletionTimeout == TimeSpan.FromSeconds(63));

        Console.WriteLine("Dictation tests passed");
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("Dictation test assertion failed");
        }
    }
}
