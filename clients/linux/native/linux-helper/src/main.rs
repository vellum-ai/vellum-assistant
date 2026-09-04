//! Entry point. stdout carries NDJSON JSON-RPC frames only; logs go to stderr.

use std::io::{self, BufReader, Write};
use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use vellum_linux_helper::rpc::codec::{self, FrameReader, ReadFrame, MAX_FRAME_BYTES};
use vellum_linux_helper::rpc::router::Router;

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            EnvFilter::try_from_env("VELLUM_HELPER_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let router = match Router::from_inventory() {
        Ok(router) => router,
        Err(error) => {
            tracing::error!(%error, "module registry is invalid");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(methods = ?router.methods(), "vellum-linux-helper ready");

    match serve(&router) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "stdio transport failed");
            ExitCode::FAILURE
        }
    }
}

/// Runs until stdin reaches EOF, which is how the supervisor asks us to stop.
fn serve(router: &Router) -> io::Result<()> {
    let mut reader = FrameReader::new(BufReader::new(io::stdin().lock()), MAX_FRAME_BYTES);
    let mut writer = io::stdout().lock();
    loop {
        match reader.next_frame()? {
            ReadFrame::Eof => return Ok(()),
            ReadFrame::Oversized => {
                tracing::warn!(max_bytes = MAX_FRAME_BYTES, "dropped an oversized frame");
                write_frame(&mut writer, &codec::parse_error())?;
            }
            ReadFrame::Line(line) => {
                if let Some(response) = router.handle_frame(&line) {
                    write_frame(&mut writer, &response)?;
                }
            }
        }
    }
}

fn write_frame(writer: &mut impl Write, frame: &str) -> io::Result<()> {
    writeln!(writer, "{frame}")?;
    writer.flush()
}
