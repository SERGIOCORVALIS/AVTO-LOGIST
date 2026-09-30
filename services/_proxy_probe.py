import sys
from pathlib import Path
import os
from dotenv import load_dotenv
load_dotenv(Path(r"c:\AVTO-logist_RU") / ".env")
import httpx
from datetime import date, timedelta

user = os.getenv("PROXY_USERNAME") or ""
password = os.getenv("PROXY_PASSWORD") or ""
hosts = [("77.73.68.222", 65000), ("89.19.215.51", 7687)]
dmy = (date.today() + timedelta(days=5)).strftime("%d-%m-%Y")
fesco = f"https://api.fesco.com/api/v1/lk/calc/fit/from?date={dmy}"
headers = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0",
    "Authorization": f"Bearer {os.getenv('PARTNER_KEY_FESCO')}",
}
timeout = httpx.Timeout(8.0, connect=4.0)
winner = None

def variants(host, port):
    out = []
    for scheme in ("socks5h", "http", "socks5"):
        out.append(f"{scheme}://{host}:{port}")
        if user and password:
            out.append(f"{scheme}://{user}:{password}@{host}:{port}")
    return out

for host, port in hosts:
    print(f"=== {host}:{port}", flush=True)
    for proxy in variants(host, port):
        scheme = proxy.split("://", 1)[0]
        auth = "auth" if "@" in proxy else "noauth"
        try:
            r = httpx.get("https://api.ipify.org", proxy=proxy, timeout=timeout)
            ip_ok = r.text.strip()
            print(f"  {scheme}/{auth} ipify={ip_ok}", flush=True)
        except Exception as e:
            print(f"  {scheme}/{auth} ipify FAIL {type(e).__name__}", flush=True)
            continue
        try:
            r = httpx.get(fesco, headers=headers, proxy=proxy, timeout=timeout, follow_redirects=True)
            print(f"  {scheme}/{auth} FESCO {r.status_code} bytes={len(r.content)}", flush=True)
            if r.status_code == 200 and len(r.content) > 10:
                winner = proxy
                break
        except Exception as e:
            print(f"  {scheme}/{auth} FESCO FAIL {type(e).__name__}: {str(e)[:90]}", flush=True)
    if winner:
        break

print("WINNER", winner or "none", flush=True)
