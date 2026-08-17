# Windows native helper

The helper targets .NET 10 and `windows10.0.17763.0`. Supported deployments must remain within Microsoft's active .NET 10 Windows support matrix.

The Electron main process starts the helper as a same-user, non-elevated child and exchanges newline-delimited JSON-RPC 2.0 frames over standard input and output.
The helper never requests elevation. Capabilities return unavailable when an elevated or protected target cannot be accessed.

RPC modules implement `IRpcModule`, are discovered from the helper assembly, and are concrete with a parameterless constructor.
Adding a module requires no edits to `Program.cs` or a central method switch. Shared capability interfaces let later modules exchange input, text, dictation,
and notification providers without coupling their protocols.

Native coordinates use physical pixels in the Windows virtual desktop space, including its possible negative origin. A capability that consumes logical or
per-monitor coordinates owns conversion at its API boundary.

Release builds publish self-contained, single-file `win-x64` and `win-arm64`
executables under the Electron resources directory. Users do not install a
separate .NET runtime. Packaging must preserve architecture selection.

Development and CI artifacts are unsigned. The release composition workflow
owns signing and signature verification for the helper executable and every
native dependency included beside it.
