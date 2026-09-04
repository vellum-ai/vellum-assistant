//! Drives the real binary the way `@vellumai/native-sidecar` does.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn answers_ping_rejects_garbage_and_exits_on_stdin_close() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vellum-linux-helper"))
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
        assert!(round_trip("{ not json").contains("-32700"));
        assert!(round_trip(r#"{"jsonrpc":"2.0","id":3,"method":"missing"}"#).contains("-32601"));
    }

    // Stdin close is the shutdown signal.
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success(), "helper exited with {status}");
}
