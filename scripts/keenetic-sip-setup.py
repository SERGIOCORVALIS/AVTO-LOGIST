"""Configure ZyXEL Keenetic Omni II for Beeline SIP (UDP 5060 + RTP)."""
from __future__ import annotations

import sys
import time
import telnetlib

HOST = "192.168.1.1"
LAN_HOST = "192.168.1.33"  # this PC (Wi-Fi)
SIP_PORT = 5060
RTP_FROM, RTP_TO = 10000, 20000


def read_all(tn: telnetlib.Telnet, wait: float = 0.4) -> str:
    time.sleep(wait)
    return tn.read_very_eager().decode("utf-8", "replace").replace("\x1b[K", "")


def run(tn: telnetlib.Telnet, command: str, wait: float = 1.6) -> str:
    tn.write(command.encode("ascii") + b"\r\n")
    out = read_all(tn, wait)
    print(f"\n>>> {command}\n{out}")
    return out


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    tn = telnetlib.Telnet(HOST, 23, timeout=10)
    banner = read_all(tn, 0.8)
    print("BANNER:\n", banner)

    run(tn, "show interface ISP", 2.2)
    run(tn, "show version", 1.5)

    # Keep source UDP port 5060 through NAT (needed for Beeline)
    run(tn, "ip nat udp-port-preserve", 1.2)

    # Port forwards: SIP signaling + RTP media to this PC
    run(tn, f"ip static udp ISP {SIP_PORT} {LAN_HOST}", 1.4)
    run(tn, f"ip static tcp ISP {SIP_PORT} {LAN_HOST}", 1.4)
    run(tn, f"ip static udp ISP {RTP_FROM} through {RTP_TO} {LAN_HOST}", 1.8)

    # Try to disable SIP ALG / nathelper-sip without a firmware rebuild
    for c in (
        "no ip helper sip",
        "no ip nat helper sip",
        "ip nat helper sip disable",
        "no service sip-alg",
        "no nathelper-sip",
    ):
        run(tn, c, 1.0)

    # Component removal (may require commit/reboot — do not commit unless remove is accepted)
    run(tn, "components list", 2.5)
    run(tn, "components remove nathelper-sip", 2.0)

    run(tn, "system configuration save", 2.5)
    run(tn, "show running-config", 4.0)
    tn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
