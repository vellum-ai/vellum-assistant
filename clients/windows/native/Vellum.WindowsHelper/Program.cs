using System.Reflection;
using Vellum.WindowsHelper.Rpc;
using Vellum.WindowsHelper.Modules;

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    shutdown.Cancel();
};

var registry = ModuleRegistry.Discover(Assembly.GetExecutingAssembly());
ObservationSeams.CuSource = new WindowsCuObservationSource();
try
{
    while (await Console.In.ReadLineAsync(shutdown.Token) is { } frame)
    {
        var response = await registry.ProcessFrameAsync(frame, shutdown.Token);
        if (response is null)
        {
            continue;
        }
        await Console.Out.WriteLineAsync(response);
        await Console.Out.FlushAsync(shutdown.Token);
    }
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
{
}
