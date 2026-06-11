import Darwin
import Foundation

/// Re-exec the helper with TCC responsibility disclaimed.
///
/// macOS attributes privacy-sensitive access (microphone, speech
/// recognition) to the *responsible process* — normally the outermost
/// ancestor app. When the Electron shell runs from a dev terminal, that
/// resolves to the IDE/terminal (e.g. PyCharm), whose Info.plist lacks the
/// usage strings, and the first privacy API touch aborts the helper with a
/// TCC SIGABRT. Disclaiming makes the helper its own responsible process,
/// so the Info.plist embedded in its `__TEXT,__info_plist` section is the
/// one TCC consults — in dev, packaged, and any launcher.
///
/// `responsibility_spawnattrs_setdisclaim` is the same private-but-stable
/// API Chromium and VS Code use for their helpers. It's resolved via
/// `dlsym` so a future macOS removing it degrades to a no-op instead of a
/// link failure. `POSIX_SPAWN_SETEXEC` replaces the current image in place
/// (same pid, stdio pipes preserved), so the supervising Electron main
/// never notices the re-exec.
///
/// Returns true when the current process is already running disclaimed.
func ensureDisclaimedResponsibility() -> Bool {
    let marker = "VELLUM_HELPER_DISCLAIMED"
    if ProcessInfo.processInfo.environment[marker] == "1" {
        return true
    }

    typealias SetDisclaimFn = @convention(c) (
        UnsafeMutablePointer<posix_spawnattr_t?>, Int32
    ) -> Int32
    guard
        let sym = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2), // RTLD_DEFAULT
            "responsibility_spawnattrs_setdisclaim"
        )
    else {
        return false
    }
    let setDisclaim = unsafeBitCast(sym, to: SetDisclaimFn.self)

    var attrs: posix_spawnattr_t?
    guard posix_spawnattr_init(&attrs) == 0 else { return false }
    defer { posix_spawnattr_destroy(&attrs) }
    guard posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETEXEC)) == 0,
          setDisclaim(&attrs, 1) == 0
    else {
        return false
    }

    var executable = [CChar](repeating: 0, count: 4096)
    var size = UInt32(executable.count)
    guard _NSGetExecutablePath(&executable, &size) == 0 else { return false }

    let args = CommandLine.arguments
    var argv: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
    argv.append(nil)

    var env = ProcessInfo.processInfo.environment
    env[marker] = "1"
    var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)

    var pid: pid_t = 0
    // With SETEXEC this only returns on failure.
    _ = posix_spawn(&pid, executable, nil, &attrs, argv, envp)

    for pointer in argv { free(pointer) }
    for pointer in envp { free(pointer) }
    return false
}
