//! Drives the real binary the way `@vellumai/native-sidecar` does.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn answers_ping_rejects_garbage_and_exits_on_stdin_close() {
    let bus_path =
        std::env::temp_dir().join(format!("vellum-stalled-bus-{}.sock", std::process::id()));
    let listener = UnixListener::bind(&bus_path).expect("bind stalled bus");
    let mut child = Command::new(env!("CARGO_BIN_EXE_vellum-linux-helper"))
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", bus_path.display()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    {
        let mut round_trip = |frame: &str| {
            writeln!(stdin, "{frame}").expect("write frame");
            let mut response = String::new();
            stdout.read_line(&mut response).expect("read response");
            response
        };
        assert_eq!(
            round_trip(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).trim_end(),
            r#"{"id":1,"jsonrpc":"2.0","result":"pong"}"#
        );
        let probe_started = Instant::now();
        let capabilities: serde_json::Value = serde_json::from_str(&round_trip(
            r#"{"jsonrpc":"2.0","id":4,"method":"capabilities.state"}"#,
        ))
        .expect("capabilities response");
        assert!(probe_started.elapsed() < Duration::from_secs(2));
        assert!(capabilities["result"]["sessionBusError"].is_string());
        let methods = capabilities["result"]["methods"]
            .as_array()
            .expect("methods");
        assert!(!methods.iter().any(|method| method == "cu.perform"));
        assert!(round_trip(r#"{"jsonrpc":"2.0","id":5,"method":"cu.perform"}"#).contains("-32601"));
        assert!(round_trip(r#"{"jsonrpc":"2.0","id":6,"method":"ping"}"#).contains("pong"));
        assert!(round_trip("{ not json").contains("-32700"));
        assert!(round_trip(r#"{"jsonrpc":"2.0","id":3,"method":"missing"}"#).contains("-32601"));
    }

    // Stdin close is the shutdown signal.
    drop(stdin);
    let status = child.wait().expect("wait");
    drop(listener);
    std::fs::remove_file(bus_path).expect("remove stalled bus");
    assert!(status.success(), "helper exited with {status}");
}
