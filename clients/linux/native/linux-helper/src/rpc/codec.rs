//! NDJSON framing plus JSON-RPC 2.0 request and response encoding.

use std::io::BufRead;

use serde_json::{json, Value};

use crate::rpc::error::{RpcError, INVALID_REQUEST, PARSE_ERROR};

/// Frames past this size are dropped instead of buffered, so a peer that
/// never writes a newline cannot exhaust helper memory.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// One decoded JSON-RPC request. `id` is absent for notifications.
pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

pub enum ReadFrame {
    Line(Vec<u8>),
    Oversized,
    Eof,
}

pub struct FrameReader<R: BufRead> {
    inner: R,
    max_bytes: usize,
}

impl<R: BufRead> FrameReader<R> {
    pub fn new(inner: R, max_bytes: usize) -> Self {
        Self { inner, max_bytes }
    }

    /// Reads the next newline-terminated frame. A frame over `max_bytes` is
    /// discarded up to its newline and reported as `Oversized`.
    pub fn next_frame(&mut self) -> std::io::Result<ReadFrame> {
        let mut line = Vec::new();
        let mut oversized = false;
        loop {
            let available = self.inner.fill_buf()?;
            if available.is_empty() {
                return Ok(if oversized {
                    ReadFrame::Oversized
                } else if line.is_empty() {
                    ReadFrame::Eof
                } else {
                    ReadFrame::Line(line)
                });
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => {
                    if !oversized {
                        line.extend_from_slice(&available[..index]);
                    }
                    self.inner.consume(index + 1);
                    return Ok(if oversized || line.len() > self.max_bytes {
                        ReadFrame::Oversized
                    } else {
                        ReadFrame::Line(line)
                    });
                }
                None => {
                    let length = available.len();
                    if !oversized {
                        line.extend_from_slice(available);
                    }
                    self.inner.consume(length);
                    if line.len() > self.max_bytes {
                        oversized = true;
                        line.clear();
                    }
                }
            }
        }
    }
}

/// Decodes a frame, or returns the id to answer with and the error to send.
pub fn decode(frame: &[u8]) -> Result<Request, (Option<Value>, RpcError)> {
    let value: Value = serde_json::from_slice(frame)
        .map_err(|_| (None, RpcError::new(PARSE_ERROR, "Parse error")))?;
    let invalid = || RpcError::new(INVALID_REQUEST, "Invalid Request");
    let Some(object) = value.as_object() else {
        return Err((None, invalid()));
    };
    let id = match object.get("id") {
        None => None,
        Some(id @ (Value::String(_) | Value::Number(_) | Value::Null)) => Some(id.clone()),
        Some(_) => return Err((None, invalid())),
    };
    let method = object.get("method").and_then(Value::as_str).unwrap_or("");
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_empty() {
        return Err((id, invalid()));
    }
    Ok(Request {
        id,
        method: method.to_string(),
        params: object.get("params").cloned(),
    })
}

pub fn success(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

pub fn error_response(id: Option<&Value>, error: &RpcError) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(Value::Null),
        "error": { "code": error.code, "message": error.message },
    })
    .to_string()
}

pub fn parse_error() -> String {
    error_response(None, &RpcError::new(PARSE_ERROR, "Parse error"))
}

/// Server-initiated frame: a request with no id, so no reply comes back.
pub fn notification(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(input: &str, max_bytes: usize) -> Vec<Result<String, ()>> {
        let mut reader = FrameReader::new(input.as_bytes(), max_bytes);
        let mut frames = Vec::new();
        loop {
            match reader.next_frame().expect("read") {
                ReadFrame::Eof => return frames,
                ReadFrame::Oversized => frames.push(Err(())),
                ReadFrame::Line(line) => frames.push(Ok(String::from_utf8(line).expect("utf8"))),
            }
        }
    }

    #[test]
    fn splits_on_newlines_and_drops_oversized_frames() {
        assert_eq!(
            read_all("one\ntwo\nthree", MAX_FRAME_BYTES),
            [Ok("one".into()), Ok("two".into()), Ok("three".into())]
        );
        // The frame after an oversized one still gets through.
        assert_eq!(read_all("aaaaaaaa\nok\n", 4), [Err(()), Ok("ok".into())]);
    }

    #[test]
    fn rejects_malformed_and_non_conforming_frames() {
        assert!(matches!(decode(b"{ not json"), Err((None, error)) if error.code == PARSE_ERROR));
        let framed = br#"{"jsonrpc":"1.0","id":4,"method":"ping"}"#;
        assert!(matches!(decode(framed), Err((Some(_), error)) if error.code == INVALID_REQUEST));
    }

    #[test]
    fn decodes_requests_and_notifications() {
        let request = decode(br#"{"jsonrpc":"2.0","id":7,"method":"ping","params":{"a":1}}"#)
            .unwrap_or_else(|_| panic!("expected a request"));
        assert_eq!(request.id, Some(json!(7)));
        assert_eq!(request.method, "ping");
        assert_eq!(request.params, Some(json!({ "a": 1 })));
        let notification = decode(br#"{"jsonrpc":"2.0","method":"ping"}"#)
            .unwrap_or_else(|_| panic!("expected a notification"));
        assert_eq!(notification.id, None);
    }
}
