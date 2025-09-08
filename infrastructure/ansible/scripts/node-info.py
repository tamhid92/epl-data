#!/usr/bin/env python3
from prometheus_client import start_http_server, Gauge
import psutil, time, socket, subprocess, re, os, signal

EXPORTER_PORT = int(os.getenv("EXPORTER_PORT", "9101"))
PING_TARGET   = os.getenv("PING_TARGET", "8.8.8.8")
SCRAPE_EVERY  = float(os.getenv("SCRAPE_EVERY", "15"))

# Stable metric names + labels (no hostname in the name)
CPU_USAGE      = Gauge("node_cpu_usage_percent", "CPU usage percentage", ["node"])
MEM_USAGE      = Gauge("node_memory_usage_percent", "Memory usage percentage", ["node"])
DISK_USAGE     = Gauge("node_disk_usage_percent", "Disk usage percentage", ["node", "mountpoint"])
NETWORK_LAT_MS = Gauge("node_network_latency_ms", "Network latency (ICMP RTT) in ms", ["node", "target"])

HOSTNAME = socket.gethostname()

def ping_rtt_ms(host: str):
    try:
        # -c 1: single packet, -n: numeric, -w 2: 2s timeout
        p = subprocess.run(
            ["ping", "-n", "-c", "1", "-w", "2", host],
            capture_output=True, text=True, check=False
        )
        if p.returncode != 0:
            return None
        m = re.search(r"time[=<]([\d\.]+)\s*ms", p.stdout)
        return float(m.group(1)) if m else None
    except Exception:
        return None

def collect_once():
    # CPU
    cpu = psutil.cpu_percent(interval=0.2)
    CPU_USAGE.labels(HOSTNAME).set(cpu)

    # Memory
    mem = psutil.virtual_memory().percent
    MEM_USAGE.labels(HOSTNAME).set(mem)

    # Disk (root only — extend if you want more mountpoints)
    root = psutil.disk_usage('/')
    DISK_USAGE.labels(HOSTNAME, "/").set(root.percent)

    # ICMP latency
    rtt = ping_rtt_ms(PING_TARGET)
    if rtt is not None:
        NETWORK_LAT_MS.labels(HOSTNAME, PING_TARGET).set(rtt)

def main():
    # Start HTTP server at /metrics
    start_http_server(EXPORTER_PORT)

    stop = {"done": False}
    def _sig(*_):
        stop["done"] = True
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, _sig)

    while not stop["done"]:
        try:
            collect_once()
        except Exception:
            pass
        time.sleep(SCRAPE_EVERY)

if __name__ == "__main__":
    main()
