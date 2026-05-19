fn main() {
    // Tauri's `tauri_build::build()` already embeds `src-tauri/Info.plist`
    // into the binary's `__TEXT,__info_plist` section on macOS, so both
    // `tauri dev` and `tauri build` pick up our usage-description keys
    // automatically. Adding a second `-sectcreate __info_plist …` linker
    // flag here causes macOS to receive two concatenated plist documents,
    // which CoreFoundation's parser rejects and TCC then treats as
    // "no usage description present" — that surfaces as a hard
    // EXC_CRASH/SIGABRT the moment Speech Recognition (or any TCC-gated
    // API) is touched.
    //
    // Touch `Info.plist` from the build script just to invalidate the
    // build cache when the plist changes; the actual embedding is
    // handled by `tauri_build`.
    println!("cargo:rerun-if-changed=Info.plist");
    tauri_build::build()
}
