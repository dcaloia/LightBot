#!/usr/bin/env python3
"""Generate known-good protocol fixtures from the reference Python implementation.

Uses the MIT-licensed ``tuya-ble`` package (pip install tuya-ble pycryptodome) so the
JavaScript port can be checked byte-for-byte against it. Output: test/fixtures.json.

    python3 tools/gen_fixtures.py
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

from tuya_ble import tuya_ble as ref
from tuya_ble.const import TuyaBLECode

LOCAL_KEY = "k3yF0rT3st5=0nly"  # test-only value; only the first 6 characters matter
UUID = "tuya0123456789ab"
DEVICE_ID = "ebtestdevice0001"
SRAND = bytes.fromhex("0102030405ff")
IV = bytes(range(16))


class _Dev:
    address = "AA:BB:CC:DD:EE:FF"
    name = "Fingerbot"


def make_client() -> ref.TuyaBLE:
    client = ref.TuyaBLE(None, _Dev(), None)
    client._local_key = LOCAL_KEY[:6].encode()
    client._login_key = hashlib.md5(client._local_key).digest()
    client._session_key = hashlib.md5(client._local_key + SRAND).digest()
    client._protocol_version = 3
    return client


def main() -> None:
    secrets.token_bytes = lambda n: IV[:n]  # deterministic IV for the fixtures
    client = make_client()

    pair = bytearray()
    pair += UUID.encode() + LOCAL_KEY[:6].encode() + DEVICE_ID.encode()
    pair += b"\x00" * (44 - len(pair))

    dps = bytes([2, 1, 1, 1])  # DP 2, bool, len 1, true
    dps_long = bytes([8, 4, 1, 0]) + bytes([2, 1, 1, 1]) + bytes([9, 2, 4, 0, 0, 0, 80])

    fixtures = {
        "localKey": LOCAL_KEY,
        "uuid": UUID,
        "deviceId": DEVICE_ID,
        "srand": SRAND.hex(),
        "iv": IV.hex(),
        "loginKey": client._login_key.hex(),
        "sessionKey": client._session_key.hex(),
        "md5": {
            "": hashlib.md5(b"").hexdigest(),
            "abc": hashlib.md5(b"abc").hexdigest(),
            "The quick brown fox jumps over the lazy dog": hashlib.md5(
                b"The quick brown fox jumps over the lazy dog"
            ).hexdigest(),
            "x" * 200: hashlib.md5(b"x" * 200).hexdigest(),
        },
        "crc16": {
            "": ref.TuyaBLE._calc_crc16(b""),
            "313233343536373839": ref.TuyaBLE._calc_crc16(b"123456789"),
            "00000001000000000000000000": ref.TuyaBLE._calc_crc16(bytes.fromhex("00000001000000000000000000")),
        },
        "packets": {
            "deviceInfo": [p.hex() for p in client._build_packets(1, TuyaBLECode.FUN_SENDER_DEVICE_INFO, b"")],
            "pair": [p.hex() for p in client._build_packets(2, TuyaBLECode.FUN_SENDER_PAIR, bytes(pair))],
            "status": [p.hex() for p in client._build_packets(3, TuyaBLECode.FUN_SENDER_DEVICE_STATUS, b"")],
            "dps": [p.hex() for p in client._build_packets(4, TuyaBLECode.FUN_SENDER_DPS, dps)],
            "dpsLong": [p.hex() for p in client._build_packets(5, TuyaBLECode.FUN_SENDER_DPS, dps_long)],
            "timeReply": [
                p.hex()
                for p in client._build_packets(6, TuyaBLECode.FUN_RECEIVE_TIME1_REQ, b"1789565629779" + (-400).to_bytes(2, "big", signed=True), 9)
            ],
        },
        # A message as the device would send it (flag 5, session key): DP report.
        "deviceMessages": {
            "dpReport": {
                "fragments": [p.hex() for p in client._build_packets(7, TuyaBLECode.FUN_RECEIVE_DP, bytes([8, 4, 1, 0, 2, 1, 1, 0, 10, 2, 4, 0, 0, 0, 3]))],
                "seq": 7,
                "dps": [[8, 4, 0], [2, 1, False], [10, 2, 3]],
            },
            "pairOk": {
                "fragments": [p.hex() for p in client._build_packets(20, TuyaBLECode.FUN_SENDER_PAIR, bytes([0]), 2)],
                "seq": 20,
                "responseTo": 2,
            },
        },
    }

    out = Path(__file__).resolve().parent.parent / "test" / "fixtures.json"
    out.write_text(json.dumps(fixtures, indent=2) + "\n")
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    sys.exit(main())
