"""Unit tests for the conntrack line parser used by connection_tailer."""

import unittest

from connection_tailer import LINE_RE, parse_event_line, fmt_iso  # type: ignore


class ParseEventLineTests(unittest.TestCase):
    def test_new_event_extracts_original_tuple_and_zero_reply_counters(self) -> None:
        line = (
            "[1747681234.567890] [NEW] tcp 6 120 SYN_SENT "
            "src=172.17.0.2 dst=104.18.32.115 sport=51234 dport=443 "
            "packets=1 bytes=60 [UNREPLIED] "
            "src=104.18.32.115 dst=172.17.0.2 sport=443 dport=51234 "
            "packets=0 bytes=0 mark=0"
        )
        parsed = parse_event_line(line)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["event"], "NEW")
        self.assertEqual(parsed["proto"], "tcp")
        self.assertEqual(parsed["src_addr"], "172.17.0.2")
        self.assertEqual(parsed["src_port"], 51234)
        self.assertEqual(parsed["dst_addr"], "104.18.32.115")
        self.assertEqual(parsed["dst_port"], 443)
        self.assertEqual(parsed["bytes_sent"], 60)
        self.assertEqual(parsed["packets_sent"], 1)
        self.assertEqual(parsed["bytes_recv"], 0)
        self.assertEqual(parsed["packets_recv"], 0)

    def test_destroy_event_carries_both_direction_counters(self) -> None:
        line = (
            "[1747681237.890123] [DESTROY] tcp 6 "
            "src=172.17.0.2 dst=104.18.32.115 sport=51234 dport=443 "
            "packets=12 bytes=1234 "
            "src=104.18.32.115 dst=172.17.0.2 sport=443 dport=51234 "
            "packets=14 bytes=5678 mark=0"
        )
        parsed = parse_event_line(line)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["event"], "DESTROY")
        self.assertEqual(parsed["dst_addr"], "104.18.32.115")
        self.assertEqual(parsed["dst_port"], 443)
        self.assertEqual(parsed["bytes_sent"], 1234)
        self.assertEqual(parsed["packets_sent"], 12)
        self.assertEqual(parsed["bytes_recv"], 5678)
        self.assertEqual(parsed["packets_recv"], 14)

    def test_destroy_without_state_field(self) -> None:
        # `conntrack -E` DESTROY rows do not include a TCP state token
        # the way NEW rows do. Make sure we still parse them.
        line = (
            "[1747681237.890123] [DESTROY] tcp 6 "
            "src=10.0.0.5 dst=8.8.8.8 sport=44444 dport=53 "
            "packets=1 bytes=60 "
            "src=8.8.8.8 dst=10.0.0.5 sport=53 dport=44444 "
            "packets=1 bytes=180"
        )
        parsed = parse_event_line(line)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["event"], "DESTROY")
        self.assertEqual(parsed["bytes_recv"], 180)

    def test_unrelated_line_returns_none(self) -> None:
        self.assertIsNone(parse_event_line("conntrack v1.4.7 (conntrack-tools): waiting"))
        self.assertIsNone(parse_event_line(""))
        self.assertIsNone(parse_event_line("[1747681237.890123] [UPDATE] tcp 6 ESTABLISHED"))


class FmtIsoTests(unittest.TestCase):
    def test_iso_format_uses_Z_suffix_and_ms_precision(self) -> None:
        result = fmt_iso(1747681234.567890)
        self.assertTrue(result.endswith("Z"))
        # millisecond precision means exactly 3 digits after the dot.
        self.assertRegex(result, r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")


if __name__ == "__main__":
    unittest.main()
