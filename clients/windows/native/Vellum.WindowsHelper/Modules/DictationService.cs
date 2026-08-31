using System.Globalization;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Text.Json;
using Vellum.WindowsHelper.Rpc;
using Windows.Media.SpeechRecognition;
using WinRtSpeechRecognizer = Windows.Media.SpeechRecognition.SpeechRecognizer;

namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Streaming and one-shot dictation over the same JSON-RPC surface as the
/// macOS helper. Audio is pushed by the renderer as base64 16 kHz mono
/// Int16 LE PCM; without pushed audio the recognizer taps the system default
/// input device. Audio and transcripts only ever live in memory.
///
/// Sessions start on-device (System.Speech). A tap session that stays
/// silent, or whose recognizer dies, is retried once on the server path
/// (WinRT online dictation), mirroring the macOS helper's watchdog.
/// </summary>
public sealed class DictationService : IRpcModule, IDictationSink
{
    private readonly DictationSessionManager _manager = new(
        request => request.RequireOnDevice
            ? new SystemSpeechEngine(request)
            : new OnlineSpeechEngine(request),
        HelperNotifications.Emit);

    public string CapabilityId => "dictation";

    public IReadOnlyCollection<string> Methods { get; } = [
        "dictation.setPartials",
        "dictation.appendAudio",
        "dictation.transcribe",
    ];

    public ValueTask<object?> InvokeAsync(
        string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        // Malformed params throw and surface as JSON-RPC internal errors.
        object result = method switch
        {
            "dictation.setPartials" => _manager.SetPartials(
                Prop(parameters, "enable")?.ValueKind == JsonValueKind.True,
                Prop(parameters, "pushAudio")?.ValueKind == JsonValueKind.True,
                Prop(parameters, "sampleRate")?.GetInt32() ?? 16000),
            "dictation.appendAudio" => _manager.AppendAudio(
                Prop(parameters, "audio")?.GetString() ?? ""),
            "dictation.transcribe" => _manager.Transcribe(
                Prop(parameters, "audio")?.GetString() ?? "",
                Prop(parameters, "sampleRate")?.GetInt32() ?? 16000,
                Prop(parameters, "requestId")?.GetString() ?? ""),
            _ => throw new RpcMethodNotFoundException(method),
        };
        return ValueTask.FromResult<object?>(result);
    }

    private static JsonElement? Prop(JsonElement? parameters, string name) =>
        parameters?.TryGetProperty(name, out var value) == true ? value : null;
}

public sealed class DictationUnavailableException(string reason)
    : Exception(reason);

public sealed record DictationEngineRequest(
    bool PushAudio,
    int SampleRate,
    bool RequireOnDevice = true);

/// <summary>Recognition engine seam so session behavior is testable.</summary>
public interface IDictationEngine : IDisposable
{
    string Tap { get; }

    /// <summary>Whether the input carried speech-level audio so far.</summary>
    bool HeardAudio { get; }

    event Action<string>? Partial;
    event Action<string>? Finalized;
    event Action<string>? Failed;

    void Start();
    void Append(byte[] pcm);
    void Finish(TimeSpan completionTimeout);
    void Cancel();
}

/// <summary>
/// Session state machine. A generation counter guards engine callbacks so
/// a replaced or cancelled session can never emit into its successor.
/// </summary>
public sealed class DictationSessionManager(
    Func<DictationEngineRequest, IDictationEngine> engineFactory,
    Action<string, object> notify,
    TimeSpan? silentStartWatchdog = null)
{
    private static readonly TimeSpan StreamingCompletionTimeout =
        TimeSpan.FromSeconds(3);
    private static readonly TimeSpan TranscriptionCompletionGrace =
        TimeSpan.FromSeconds(3);
    // Matches the macOS helper: a pinned session with no partial, error or
    // final by then is treated as hung.
    private static readonly TimeSpan DefaultSilentStartWatchdog =
        TimeSpan.FromSeconds(2.5);

    private readonly TimeSpan _silentStartWatchdog =
        silentStartWatchdog ?? DefaultSilentStartWatchdog;
    private readonly object _gate = new();
    private IDictationEngine? _engine;
    private int _generation;
    private bool _sawActivity;
    private IDictationEngine? _transcriptionEngine;
    private int _transcriptionGeneration;

    public object SetPartials(bool enable, bool pushAudio, int sampleRate)
    {
        lock (_gate)
        {
            if (!enable)
            {
                // Graceful stop: let recognition drain into `finalized`.
                _engine?.Finish(StreamingCompletionTimeout);
                _engine = null;
                return new { enabled = false };
            }

            CancelLocked();
            return StartLocked(new DictationEngineRequest(pushAudio, sampleRate));
        }
    }

    private object StartLocked(DictationEngineRequest request)
    {
        var generation = ++_generation;
        _sawActivity = false;
        // Only a tap session can move to the server path: the online
        // engine cannot replay pushed PCM, and short push dictations settle
        // through `dictation.transcribe` anyway.
        var canRetryServer = request.RequireOnDevice && !request.PushAudio;
        IDictationEngine engine;
        try
        {
            engine = engineFactory(request);
        }
        catch (DictationUnavailableException err)
        {
            return StartFailedLocked(err.Message, request, canRetryServer);
        }
        engine.Partial += text => IfCurrent(generation, () =>
        {
            _sawActivity = true;
            notify("dictation.partial", new { text });
        });
        engine.Failed += message =>
        {
            // A session already stopped by SetPartials(false) must not
            // retry: that would reopen the microphone after the user let go.
            ReleaseIfCurrent(generation, engine, wasActive =>
            {
                _sawActivity = true;
                var retry = canRetryServer && wasActive;
                notify("dictation.error", new
                {
                    message,
                    onDevice = request.RequireOnDevice,
                    willRetryServer = retry,
                });
                if (retry)
                {
                    RetryOnServerLocked(request);
                }
            });
            _ = Task.Run(engine.Dispose);
        };
        engine.Finalized += text =>
        {
            ReleaseIfCurrent(generation, engine, _ =>
            {
                _sawActivity = true;
                notify("dictation.finalized", new { text });
            });
            _ = Task.Run(engine.Dispose);
        };
        _engine = engine;
        try
        {
            engine.Start();
        }
        catch (Exception err)
        {
            if (ReferenceEquals(_engine, engine))
            {
                _engine = null;
                engine.Dispose();
            }
            return StartFailedLocked(err.Message, request, canRetryServer);
        }
        if (!ReferenceEquals(_engine, engine))
        {
            // Failed synchronously during Start; a server retry may have
            // already replaced it.
            return _engine is null
                ? new { enabled = false, reason = "recognition failed" }
                : new { enabled = true, tap = _engine.Tap };
        }
        if (canRetryServer)
        {
            ScheduleSilentStartWatchdog(generation, engine, request);
        }
        return new { enabled = true, tap = engine.Tap };
    }

    /// <summary>
    /// A pinned recognizer can hang without a partial or an error (missing
    /// language pack, half-installed recognizer). Error-driven retry cannot
    /// catch that, so a session still silent after the watchdog delay is
    /// restarted on the server path.
    /// </summary>
    private void ScheduleSilentStartWatchdog(
        int generation,
        IDictationEngine engine,
        DictationEngineRequest request)
    {
        _ = Task.Delay(_silentStartWatchdog).ContinueWith(_ =>
        {
            lock (_gate)
            {
                if (generation != _generation ||
                    _sawActivity ||
                    !ReferenceEquals(_engine, engine))
                {
                    return;
                }
                notify("dictation.error", new
                {
                    message =
                        $"on-device recognition produced no output (heardAudio={engine.HeardAudio}, tap={engine.Tap}); retrying on the server path",
                    onDevice = true,
                    willRetryServer = true,
                });
                RetryOnServerLocked(request);
            }
        });
    }

    private void RetryOnServerLocked(DictationEngineRequest request)
    {
        CancelLocked();
        StartLocked(request with { RequireOnDevice = false });
    }

    /// <summary>
    /// A tap session whose on-device recognizer cannot even be built or
    /// started (no language pack, denied device) tries the server path;
    /// anything else is a terminal error.
    /// </summary>
    private object StartFailedLocked(
        string message,
        DictationEngineRequest request,
        bool canRetryServer)
    {
        notify("dictation.error", new
        {
            message,
            onDevice = request.RequireOnDevice,
            willRetryServer = canRetryServer,
        });
        if (!canRetryServer)
        {
            return new { enabled = false, reason = message };
        }
        return StartLocked(request with { RequireOnDevice = false });
    }

    public object AppendAudio(string base64)
    {
        byte[] pcm;
        try
        {
            pcm = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return new { ok = false };
        }
        lock (_gate)
        {
            // Chunks straddling session teardown are best-effort, like macOS.
            _engine?.Append(pcm);
        }
        return new { ok = true };
    }

    public object Transcribe(string base64, int sampleRate, string requestId)
    {
        byte[] pcm;
        try
        {
            pcm = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return new { ok = false, reason = "invalid audio" };
        }
        if (pcm.Length == 0)
        {
            return new { ok = false, reason = "empty audio" };
        }
        if (string.IsNullOrEmpty(requestId))
        {
            return new { ok = false, reason = "missing request id" };
        }

        lock (_gate)
        {
            CancelTranscriptionLocked();
            var generation = ++_transcriptionGeneration;
            IDictationEngine engine;
            try
            {
                engine = engineFactory(new DictationEngineRequest(true, sampleRate));
            }
            catch (DictationUnavailableException err)
            {
                return new { ok = false, reason = err.Message };
            }

            engine.Failed += _ => ReleaseTranscriptionIfCurrent(
                generation,
                engine,
                () => notify("dictation.transcribed", new { requestId, text = "" }));
            engine.Finalized += text => ReleaseTranscriptionIfCurrent(
                generation,
                engine,
                () => notify("dictation.transcribed", new { requestId, text }));
            _transcriptionEngine = engine;
            try
            {
                engine.Start();
                engine.Append(pcm);
                engine.Finish(TranscriptionCompletionTimeout(pcm.Length, sampleRate));
            }
            catch (Exception err)
            {
                if (ReferenceEquals(_transcriptionEngine, engine))
                {
                    _transcriptionGeneration++;
                    _transcriptionEngine = null;
                    engine.Dispose();
                }
                return new { ok = false, reason = err.Message };
            }
            return new { ok = true };
        }
    }

    private void CancelLocked()
    {
        _generation++;
        _engine?.Cancel();
        _engine?.Dispose();
        _engine = null;
    }

    private void CancelTranscriptionLocked()
    {
        _transcriptionGeneration++;
        _transcriptionEngine?.Cancel();
        _transcriptionEngine?.Dispose();
        _transcriptionEngine = null;
    }

    private static TimeSpan TranscriptionCompletionTimeout(
        int pcmByteLength,
        int sampleRate)
    {
        var bytesPerSecond = Math.Max(sampleRate, 1) * (double)sizeof(short);
        return TimeSpan.FromSeconds(
            pcmByteLength / bytesPerSecond) +
            TranscriptionCompletionGrace;
    }

    private void IfCurrent(int generation, Action action)
    {
        lock (_gate)
        {
            if (generation != _generation)
            {
                return;
            }
            action();
        }
    }

    /// <summary>
    /// Runs `action` for a same-generation callback, passing whether the
    /// engine was still the active session (false after a graceful stop).
    /// </summary>
    private void ReleaseIfCurrent(
        int generation,
        IDictationEngine engine,
        Action<bool> action)
    {
        lock (_gate)
        {
            if (generation != _generation)
            {
                return;
            }
            var wasActive = ReferenceEquals(_engine, engine);
            if (wasActive)
            {
                _engine = null;
            }
            action(wasActive);
        }
    }

    private void ReleaseTranscriptionIfCurrent(
        int generation,
        IDictationEngine engine,
        Action action)
    {
        lock (_gate)
        {
            if (generation != _transcriptionGeneration)
            {
                return;
            }
            if (ReferenceEquals(_transcriptionEngine, engine))
            {
                _transcriptionEngine = null;
            }
            action();
            _ = Task.Run(engine.Dispose);
        }
    }
}

/// <summary>
/// System.Speech (fully on-device) recognition over pushed PCM or the
/// system default input device.
/// </summary>
internal sealed class SystemSpeechEngine : IDictationEngine
{
    private readonly SpeechRecognitionEngine _engine;
    private readonly BlockingPcmStream? _pushStream;
    private readonly object _gate = new();
    private string _committed = "";
    private bool _finishing;
    private bool _completed;
    private volatile bool _heardAudio;

    public SystemSpeechEngine(DictationEngineRequest request)
    {
        var installed = SpeechRecognitionEngine.InstalledRecognizers();
        var recognizer =
            installed.FirstOrDefault(info =>
                info.Culture.TwoLetterISOLanguageName ==
                CultureInfo.CurrentUICulture.TwoLetterISOLanguageName) ??
            installed.FirstOrDefault() ??
            throw new DictationUnavailableException(
                $"no speech recognizer installed for {CultureInfo.CurrentUICulture.Name}");
        try
        {
            _engine = new SpeechRecognitionEngine(recognizer);
            _engine.LoadGrammar(new DictationGrammar());
            if (request.PushAudio)
            {
                _pushStream = new BlockingPcmStream();
                _engine.SetInputToAudioStream(
                    _pushStream,
                    new SpeechAudioFormatInfo(
                        request.SampleRate, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                Tap = $"renderer stream (pushed PCM @{request.SampleRate}Hz)";
            }
            else
            {
                // Denied or missing microphones surface here.
                _engine.SetInputToDefaultAudioDevice();
                Tap = "system default input";
            }
        }
        catch (Exception err) when (err is not DictationUnavailableException)
        {
            _pushStream?.Dispose();
            _engine?.Dispose();
            throw new DictationUnavailableException(err.Message);
        }
        _engine.SpeechHypothesized += (_, args) =>
            Partial?.Invoke(Combine(_committed, args.Result.Text));
        _engine.SpeechRecognized += (_, args) =>
        {
            lock (_gate)
            {
                _committed = Combine(_committed, args.Result.Text);
            }
            Partial?.Invoke(_committed);
        };
        _engine.RecognizeCompleted += (_, args) => Complete(args.Error?.Message);
        _engine.AudioStateChanged += (_, args) =>
        {
            if (args.AudioState == AudioState.Speech)
            {
                _heardAudio = true;
            }
        };
    }

    public string Tap { get; }

    public bool HeardAudio => _heardAudio;

    public event Action<string>? Partial;
    public event Action<string>? Finalized;
    public event Action<string>? Failed;

    public void Start() => _engine.RecognizeAsync(RecognizeMode.Multiple);

    public void Append(byte[] pcm) => _pushStream?.Push(pcm);

    public void Finish(TimeSpan completionTimeout)
    {
        lock (_gate)
        {
            _finishing = true;
        }
        _pushStream?.Complete();
        _engine.RecognizeAsyncStop();
        // Guard against a recognizer that never completes after stop.
        _ = Task.Delay(completionTimeout).ContinueWith(_ => Complete(null));
    }

    public void Cancel()
    {
        lock (_gate)
        {
            _completed = true;
        }
        _pushStream?.Complete();
        _engine.RecognizeAsyncCancel();
    }

    public void Dispose()
    {
        _pushStream?.Dispose();
        _engine.Dispose();
    }

    private void Complete(string? error)
    {
        bool finishing;
        lock (_gate)
        {
            if (_completed)
            {
                return;
            }
            _completed = true;
            finishing = _finishing;
        }
        if (error is not null && !finishing)
        {
            Failed?.Invoke(error);
            return;
        }
        Finalized?.Invoke(_committed);
    }

    private static string Combine(string committed, string next) =>
        committed.Length == 0 ? next : $"{committed} {next}";
}

/// <summary>
/// Server-path dictation through WinRT online recognition, used when the
/// on-device session stays silent or dies. WinRT only listens on the
/// system default input, so pushed PCM sessions cannot use it.
/// </summary>
internal sealed class OnlineSpeechEngine : IDictationEngine
{
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(5);

    private readonly WinRtSpeechRecognizer _recognizer;
    private readonly object _gate = new();
    private string _committed = "";
    private bool _finishing;
    private bool _completed;

    public OnlineSpeechEngine(DictationEngineRequest request)
    {
        if (request.PushAudio)
        {
            throw new DictationUnavailableException(
                "online recognition only supports the system default input");
        }
        try
        {
            _recognizer = new WinRtSpeechRecognizer();
            _recognizer.Constraints.Add(new SpeechRecognitionTopicConstraint(
                SpeechRecognitionScenario.Dictation, "dictation"));
        }
        catch (Exception err)
        {
            _recognizer?.Dispose();
            throw new DictationUnavailableException(err.Message);
        }
        _recognizer.HypothesisGenerated += (_, args) =>
            Partial?.Invoke(Combine(_committed, args.Hypothesis.Text));
        _recognizer.ContinuousRecognitionSession.ResultGenerated += (_, args) =>
        {
            lock (_gate)
            {
                _committed = Combine(_committed, args.Result.Text);
            }
            Partial?.Invoke(_committed);
        };
        _recognizer.ContinuousRecognitionSession.Completed += (_, args) =>
            Complete(args.Status == SpeechRecognitionResultStatus.Success
                ? null
                : args.Status.ToString());
    }

    public string Tap => "system default input (online)";

    // The online session reports levels only through results.
    public bool HeardAudio => _committed.Length > 0;

    public event Action<string>? Partial;
    public event Action<string>? Finalized;
    public event Action<string>? Failed;

    // Startup is synchronous so `dictation.setPartials` only acknowledges
    // a session that is really listening, but bounded: the session manager
    // holds its lock meanwhile and the online path can stall on the
    // network. Throws when offline or the online speech setting is off.
    public void Start()
    {
        var startup = StartAsync();
        var settled = Task.WhenAny(startup, Task.Delay(StartupTimeout))
            .GetAwaiter().GetResult();
        if (!ReferenceEquals(settled, startup))
        {
            Cancel();
            throw new TimeoutException("online recognition did not start in time");
        }
        startup.GetAwaiter().GetResult();
    }

    private async Task StartAsync()
    {
        var compiled = await _recognizer.CompileConstraintsAsync();
        if (compiled.Status != SpeechRecognitionResultStatus.Success)
        {
            throw new InvalidOperationException(
                $"online recognition unavailable ({compiled.Status})");
        }
        await _recognizer.ContinuousRecognitionSession.StartAsync();
    }

    public void Append(byte[] pcm)
    {
    }

    public void Finish(TimeSpan completionTimeout)
    {
        lock (_gate)
        {
            _finishing = true;
        }
        try
        {
            _ = _recognizer.ContinuousRecognitionSession.StopAsync().AsTask();
        }
        catch (Exception)
        {
            // Session already ended; the guard below finalizes.
        }
        _ = Task.Delay(completionTimeout).ContinueWith(_ => Complete(null));
    }

    public void Cancel()
    {
        lock (_gate)
        {
            _completed = true;
        }
        try
        {
            _ = _recognizer.ContinuousRecognitionSession.CancelAsync().AsTask();
        }
        catch (Exception)
        {
            // Session never started.
        }
    }

    public void Dispose() => _recognizer.Dispose();

    private void Complete(string? error)
    {
        bool finishing;
        lock (_gate)
        {
            if (_completed)
            {
                return;
            }
            _completed = true;
            finishing = _finishing;
        }
        if (error is not null && !finishing)
        {
            Failed?.Invoke(error);
            return;
        }
        Finalized?.Invoke(_committed);
    }

    private static string Combine(string committed, string next) =>
        committed.Length == 0 ? next : $"{committed} {next}";
}

/// <summary>
/// Bounded FIFO byte stream: `Read` blocks until pushed PCM arrives (or
/// the stream completes), which is what `SetInputToAudioStream` expects
/// from a live capture source.
/// </summary>
internal sealed class BlockingPcmStream : Stream
{
    private readonly Queue<byte[]> _chunks = new();
    private readonly object _gate = new();
    private byte[] _current = [];
    private int _offset;
    private bool _completed;

    public void Push(byte[] pcm)
    {
        lock (_gate)
        {
            _chunks.Enqueue(pcm);
            Monitor.PulseAll(_gate);
        }
    }

    public void Complete()
    {
        lock (_gate)
        {
            _completed = true;
            Monitor.PulseAll(_gate);
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        lock (_gate)
        {
            while (_current.Length == _offset)
            {
                if (_chunks.TryDequeue(out var next))
                {
                    _current = next;
                    _offset = 0;
                    continue;
                }
                if (_completed)
                {
                    return 0;
                }
                Monitor.Wait(_gate);
            }
            var read = Math.Min(count, _current.Length - _offset);
            Array.Copy(_current, _offset, buffer, offset, read);
            _offset += read;
            return read;
        }
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => 0;
    public override long Position { get => 0; set => throw new NotSupportedException(); }

    public override void Flush() { }

    public override long Seek(long offset, SeekOrigin origin) =>
        throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();
}

/// <summary>
/// JSON-RPC notification writer. `Console.Out` is synchronized, so each
/// serialized frame lands on stdout as one uninterleaved line alongside
/// the response frames written by the request loop.
/// </summary>
internal static class HelperNotifications
{
    public static void Emit(string method, object parameters)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(
            new { jsonrpc = "2.0", method, @params = parameters }));
        Console.Out.Flush();
    }
}
