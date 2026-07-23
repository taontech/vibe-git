"""
Agent Monitor Server — Mac-side service.

HTTP REST API + UDP service discovery for iPhone Widget polling.

Endpoints:
  GET  /status              — full status snapshot with version
  GET  /status?since=<v>    — incremental (returns null if unchanged)
  GET  /agents              — agent list only
  GET  /agents/<agent_id>   — single agent detail
  GET  /system              — system metrics only
  GET  /usage               — API quota usage (codex, claude-code)
  GET  /pair                — generate pairing QR code (PNG)
  POST /pair                — verify pairing token
  GET  /health              — liveness check
"""

import asyncio
import json
import hashlib
import secrets
import socket
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Optional

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import uvicorn
from fastapi import FastAPI, Query, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response

import qrcode

from collectors import collect_agent_status, collect_system_info
from collectors.agents import AgentStatus, agent_status_to_dict
from collectors.usage import get_usage_fetcher

# Module-level port config — overridden by --port CLI arg at runtime
HTTP_PORT = 8898
UDP_PORT = 8899

@asynccontextmanager
async def lifespan(_app: FastAPI):
    broadcaster = asyncio.create_task(status_broadcast_loop())
    try:
        yield
    finally:
        broadcaster.cancel()
        try:
            await broadcaster
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Agent Monitor", version="1.0.0", lifespan=lifespan)

# Use a wall-clock based seed so a restarted server always has a newer version
# than snapshots cached by connected apps.
STATUS_VERSION = int(time.time() * 1000)
STATUS_CACHE: dict | None = None
STATUS_BUILD_LOCK = threading.Lock()
STATUS_WEBSOCKETS: set[WebSocket] = set()
STATUS_BROADCAST_INTERVAL = 0.5

PAIRING_TOKENS: dict[str, tuple[float, str]] = {}
PAIRED_DEVICES: dict[str, dict] = {}

LOCAL_HOSTNAME = socket.gethostname()
LOCAL_IP = "0.0.0.0"


def get_local_ip() -> str:
    candidates = ["192.168.1.1", "10.0.0.1", "172.16.0.1"]
    for target in candidates:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.5)
            s.connect((target, 1))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith("127."):
                return ip
        except Exception:
            continue

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def hash_status(data: dict) -> str:
    payload = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


def _build_status_snapshot_unlocked(agent_id: Optional[str] = None) -> dict:
    global STATUS_VERSION, STATUS_CACHE

    agents = collect_agent_status(agent_id)
    system = collect_system_info()
    usage_fetcher = get_usage_fetcher()

    if usage_fetcher.needs_refresh:
        usage_fetcher.refresh()
    usage_data = usage_fetcher.to_dict()

    status_hash = hash_status({
        "system": system,
        "agents": [
            {"id": a.agent_id, "display_name": a.display_name, "status": a.status,
             "process_count": a.process_count, "total_cpu_percent": a.total_cpu_percent,
             "total_memory_mb": a.total_memory_mb, "max_uptime_seconds": a.max_uptime_seconds,
             "processes": a.processes}
            for a in agents
        ],
        "usage": usage_data,
    })

    prev_hash = STATUS_CACHE.get("content_hash") if STATUS_CACHE else None
    if prev_hash == status_hash and STATUS_CACHE:
        return STATUS_CACHE

    STATUS_VERSION += 1
    snapshot = {
        "timestamp": int(time.time()),
        "hostname": LOCAL_HOSTNAME,
        "version": STATUS_VERSION,
        "content_hash": status_hash,
        "system": system,
        "usage": usage_data,
        "agents": [
            {
                "id": a.agent_id,
                "display_name": a.display_name,
                "status": a.status,
                "process_count": a.process_count,
                "total_cpu_percent": a.total_cpu_percent,
                "total_memory_mb": a.total_memory_mb,
                "max_uptime_seconds": a.max_uptime_seconds,
                "processes": a.processes,
            }
            for a in agents
        ],
    }
    STATUS_CACHE = snapshot
    return snapshot


def build_status_snapshot(agent_id: Optional[str] = None) -> dict:
    with STATUS_BUILD_LOCK:
        return _build_status_snapshot_unlocked(agent_id)


async def status_broadcast_loop():
    last_version = 0
    while True:
        try:
            snapshot = await asyncio.to_thread(build_status_snapshot)
            if snapshot["version"] != last_version:
                last_version = snapshot["version"]
                disconnected = []
                for websocket in list(STATUS_WEBSOCKETS):
                    try:
                        await websocket.send_json(snapshot)
                    except Exception:
                        disconnected.append(websocket)
                for websocket in disconnected:
                    STATUS_WEBSOCKETS.discard(websocket)
        except Exception:
            pass
        await asyncio.sleep(STATUS_BROADCAST_INTERVAL)


@app.get("/health")
def health():
    return {"ok": True, "hostname": LOCAL_HOSTNAME, "ip": get_local_ip()}


@app.get("/status")
def get_status(since: Optional[int] = Query(None, description="Only return if version > since")):
    snapshot = build_status_snapshot()
    if since is not None and snapshot["version"] <= since:
        return JSONResponse(content={"unchanged": True, "version": snapshot["version"]})
    return JSONResponse(content=snapshot)


@app.websocket("/ws/status")
async def status_websocket(websocket: WebSocket):
    await websocket.accept()
    STATUS_WEBSOCKETS.add(websocket)
    try:
        snapshot = await asyncio.to_thread(build_status_snapshot)
        await websocket.send_json(snapshot)
        while True:
            await websocket.receive()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        STATUS_WEBSOCKETS.discard(websocket)


@app.get("/agents")
def get_agents():
    return JSONResponse(content=[agent_status_to_dict(a) for a in collect_agent_status()])


@app.get("/agents/{agent_id}")
def get_agent(agent_id: str):
    agents = collect_agent_status(agent_id)
    if not agents:
        return JSONResponse(content={"found": False, "agent_id": agent_id})
    return JSONResponse(content=agent_status_to_dict(agents[0]))


@app.get("/system")
def get_system():
    return JSONResponse(content=collect_system_info())


@app.get("/usage")
def get_usage():
    fetcher = get_usage_fetcher()
    fetcher.refresh(force=True)
    return JSONResponse(content=fetcher.to_dict())


@app.get("/pair")
def generate_pairing_qr():
    token = uuid.uuid4().hex[:8]
    local_ip = get_local_ip()
    payload = json.dumps({
        "ip": local_ip,
        "port": HTTP_PORT,
        "token": token,
        "hostname": LOCAL_HOSTNAME,
    })
    PAIRING_TOKENS[token] = (time.time(), local_ip)

    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/pair")
def confirm_pairing(token: str = Query(...), device_name: str = Query(default="iPhone")):
    entry = PAIRING_TOKENS.get(token)
    if not entry:
        raise HTTPException(status_code=400, detail="Invalid or expired pairing token")
    paired_at, ip = entry
    if time.time() - paired_at > 300:
        del PAIRING_TOKENS[token]
        raise HTTPException(status_code=400, detail="Pairing token expired")

    api_key = secrets.token_hex(32)
    device_id = uuid.uuid4().hex[:12]
    PAIRED_DEVICES[device_id] = {
        "device_name": device_name,
        "api_key": api_key,
        "paired_at": int(time.time()),
        "ip": ip,
    }
    del PAIRING_TOKENS[token]
    return JSONResponse(content={
        "device_id": device_id,
        "api_key": api_key,
        "hostname": LOCAL_HOSTNAME,
        "ip": get_local_ip(),
        "port": HTTP_PORT,
    })


def udp_broadcast_loop():
    BEACON_INTERVAL = 3
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    while True:
        try:
            ip = get_local_ip()
            agents = collect_agent_status()
            payload = json.dumps({
                "type": "agent-monitor-beacon",
                "hostname": LOCAL_HOSTNAME,
                "ip": ip,
                "http_port": HTTP_PORT,
                "udp_port": UDP_PORT,
                "timestamp": int(time.time()),
                "version": STATUS_VERSION,
                "agents_summary": [
                    {"id": a.agent_id, "status": a.status, "count": a.process_count}
                    for a in agents
                ],
            })
            sock.sendto(payload.encode(), ("255.255.255.255", UDP_PORT))
        except Exception:
            pass
        time.sleep(BEACON_INTERVAL)


def usage_refresh_loop():
    REFRESH_INTERVAL = 120
    fetcher = get_usage_fetcher()
    while True:
        try:
            fetcher.refresh()
        except Exception:
            pass
        time.sleep(REFRESH_INTERVAL)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Agent Monitor Server")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP listen host")
    parser.add_argument("--port", type=int, default=8898, help="HTTP listen port")
    parser.add_argument("--udp-port", type=int, default=8899, help="UDP broadcast port")
    parser.add_argument("--no-udp", action="store_true", help="Disable UDP broadcasting")
    args = parser.parse_args()

    HTTP_PORT = args.port
    UDP_PORT = args.udp_port

    if not args.no_udp:
        t = threading.Thread(target=udp_broadcast_loop, daemon=True)
        t.start()
        print(f"[UDP] Broadcasting on port {UDP_PORT} every 3s")

    t2 = threading.Thread(target=usage_refresh_loop, daemon=True)
    t2.start()
    print(f"[Usage] Auto-refreshing every 120s")

    # Bonjour registration
    zeroconf = None
    info = None
    try:
        from zeroconf import ServiceInfo, Zeroconf
        local_ip = get_local_ip()
        print(f"[Bonjour] Registering service _agentmon._tcp.local. on {local_ip}:{args.port}")
        zeroconf = Zeroconf()
        desc = {'ip': local_ip, 'port': str(args.port)}
        clean_hostname = LOCAL_HOSTNAME.replace('.local', '').replace(' ', '-')
        service_name = f"{clean_hostname}._agentmon._tcp.local."
        info = ServiceInfo(
            "_agentmon._tcp.local.",
            service_name,
            addresses=[socket.inet_aton(local_ip)],
            port=args.port,
            properties=desc,
        )
        zeroconf.register_service(info)
    except Exception as e:
        print(f"[Bonjour] Failed to register Bonjour service: {e}")

    print(f"Agent Monitor starting on http://{args.host}:{args.port}")
    print(f"  Local IP: {get_local_ip()}")
    print(f"  Status:   http://{get_local_ip()}:{args.port}/status")
    print(f"  Pair QR:  http://{get_local_ip()}:{args.port}/pair")
    print(f"  Health:   http://{get_local_ip()}:{args.port}/health")
    
    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        if zeroconf and info:
            print("[Bonjour] Unregistering service...")
            try:
                zeroconf.unregister_service(info)
                zeroconf.close()
            except Exception as e:
                print(f"[Bonjour] Error unregistering: {e}")
