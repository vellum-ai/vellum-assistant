#!/usr/bin/env python3
"""Connection-telemetry tailer for the egress jail.

Spawns `conntrack -E -e NEW,DESTROY -o ktimestamp,extended` and emits
one NDJSON record per closed TCP connection to TELEMETRY_OUTPUT_PATH.

Each record has the shape:

    {
      "kind": "connection",
      "ts_open":  "2026-05-19T18:34:11.123Z",
      "ts_close": "2026-05-19T18:34:14.456Z",
      "duration_ms": 3333,
      "protocol": "tcp",
      "src_addr": "172.17.0.2",
      "src_port": 51234,
      "dst_addr": "104.18.32.115",
      "dst_port": 443,
      "bytes_sent": 1234,
      "bytes_recv": 5678,
      "packets_sent": 12,
      "packets_recv": 14,
      "acct_enabled": true
    }

The destination address/port reflect the ORIGINAL (pre-NAT) tuple, so
when the recording jail's iptables NAT REDIRECT rewrites outbound
TCP/443 to localhost:8443, we still see the real Anthropic IP here.

Conntrack records the assistant's tuples because the sidecar joins
the assistant's netns via `--network container:<assistant>`.

When `nf_conntrack_acct=0` (entrypoint couldn't write the sysctl), the
byte/packet counters are zero and `acct_enabled` is false.
"""

import json
import os
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from typing import Optional

# Env vars are read inside main() rather than at module top-level so that
# importing this module (e.g. from test_connection_tailer.py to exercise the
# pure parser functions) does not require setting TELEMETRY_OUTPUT_PATH.
TELEMETRY_OUTPUT_PATH_ENV = "TELEMETRY_OUTPUT_PATH"
TELEMETRY_ACCT_ENABLED_ENV = "TELEMETRY_ACCT_ENABLED"


# Conntrack -E line format (extended + ktimestamp), e.g.:
#
#   [1747681234.567890] [NEW] tcp 6 120 SYN_SENT src=172.17.0.2 dst=104.18.32.115 sport=51234 dport=443 packets=1 bytes=60 [UNREPLIED] src=104.18.32.115 dst=172.17.0.2 sport=443 dport=51234 packets=0 bytes=0 mark=0 secctx=...
#   [1747681237.890123] [DESTROY] tcp 6 src=172.17.0.2 dst=104.18.32.115 sport=51234 dport=443 packets=12 bytes=1234 src=104.18.32.115 dst=172.17.0.2 sport=443 dport=51234 packets=14 bytes=5678 ...
#
# The first src=/dst=/sport=/dport= block is the ORIGINAL direction
# (assistant → peer), the second is the REPLY direction (peer →
# assistant). For DESTROY events, both blocks carry final cumulative
# packets/bytes counters.

LINE_RE = re.compile(
    r"^\[(?P<ts>[\d.]+)\]\s+"
    r"\[(?P<event>NEW|DESTROY|UPDATE)\]\s+"
    r"(?P<proto>tcp|udp)\s+"
    r"(?P<proto_num>\d+)\s+"
    r"(?:(?P<ttl>\d+)\s+)?"
    r"(?:(?P<state>[A-Z_]+)\s+)?"
    r"(?P<rest>.*)$"
)

KV_RE = re.compile(r"(\w+)=(\S+)")


def parse_event_line(line: str) -> Optional[dict]:
    m = LINE_RE.match(line)
    if not m:
        return None
    ts = float(m.group("ts"))
    event = m.group("event")
    proto = m.group("proto")
    rest = m.group("rest")

    # Pull all key=value pairs. The order matters because keys repeat
    # for the original vs reply directions.
    kvs = KV_RE.findall(rest)
    original = {}
    reply = {}
    cursor = original
    seen_orig_packets = False
    for k, v in kvs:
        if k in cursor and k in ("src", "dst", "sport", "dport"):
            # repeated src/dst/sport/dport marks the boundary into the
            # reply block
            cursor = reply
        cursor[k] = v
        if k == "packets" and cursor is original:
            seen_orig_packets = True
        elif k == "packets" and cursor is reply and not seen_orig_packets:
            # reply block can start before we see original packets
            # when conntrack -o extended emits a [UNREPLIED] marker
            seen_orig_packets = True

    if not original.get("src") or not original.get("dst"):
        return None

    return {
        "ts": ts,
        "event": event,
        "proto": proto,
        "src_addr": original["src"],
        "src_port": int(original.get("sport", 0)),
        "dst_addr": original["dst"],
        "dst_port": int(original.get("dport", 0)),
        "bytes_sent": int(original.get("bytes", 0)),
        "packets_sent": int(original.get("packets", 0)),
        "bytes_recv": int(reply.get("bytes", 0)),
        "packets_recv": int(reply.get("packets", 0)),
    }


def fmt_iso(ts: float) -> str:
    return (
        datetime.fromtimestamp(ts, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def connection_key(parsed: dict) -> tuple:
    return (
        parsed["proto"],
        parsed["src_addr"],
        parsed["src_port"],
        parsed["dst_addr"],
        parsed["dst_port"],
    )


def main() -> int:
    # Read env vars here (not at module load) so the module stays
    # importable from tests without requiring runtime env setup.
    output_path = os.environ[TELEMETRY_OUTPUT_PATH_ENV]
    acct_enabled = (
        os.environ.get(TELEMETRY_ACCT_ENABLED_ENV, "false").lower() == "true"
    )

    # Track NEW timestamps keyed by 5-tuple so we can compute duration
    # at DESTROY time.
    first_seen: dict[tuple, float] = {}

    # Open in line-buffered append mode so partial writes during
    # mid-record SIGTERM never corrupt the NDJSON.
    out = open(output_path, "a", buffering=1)

    cmd = [
        "conntrack",
        "-E",
        "-e",
        "NEW,DESTROY",
        "-p",
        "tcp",
        "-o",
        "ktimestamp,extended",
    ]
    print(f"[connection-telemetry] spawning: {' '.join(cmd)}", file=sys.stderr)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    # Drain stderr to our own stderr so conntrack errors are visible
    # in `docker logs` without interleaving into stdout.
    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            print(f"[conntrack] {line.rstrip()}", file=sys.stderr)

    threading.Thread(target=drain_stderr, daemon=True).start()

    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if not line:
            continue
        parsed = parse_event_line(line)
        if not parsed:
            continue
        key = connection_key(parsed)
        if parsed["event"] == "NEW":
            # Only set first_seen the first time — conntrack can emit
            # multiple NEWs in pathological cases (very rare; mostly
            # for short-lived UDP, but we filter to TCP).
            first_seen.setdefault(key, parsed["ts"])
        elif parsed["event"] == "DESTROY":
            opened = first_seen.pop(key, parsed["ts"])
            record = {
                "kind": "connection",
                "ts_open": fmt_iso(opened),
                "ts_close": fmt_iso(parsed["ts"]),
                "duration_ms": int((parsed["ts"] - opened) * 1000),
                "protocol": parsed["proto"],
                "src_addr": parsed["src_addr"],
                "src_port": parsed["src_port"],
                "dst_addr": parsed["dst_addr"],
                "dst_port": parsed["dst_port"],
                "bytes_sent": parsed["bytes_sent"],
                "bytes_recv": parsed["bytes_recv"],
                "packets_sent": parsed["packets_sent"],
                "packets_recv": parsed["packets_recv"],
                "acct_enabled": acct_enabled,
            }
            out.write(json.dumps(record) + "\n")

    rc = proc.wait()
    out.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
