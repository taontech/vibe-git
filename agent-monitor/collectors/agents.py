"""
Agent process collectors for opencode, claude code, and codex CLI tools.

Detection strategy:
  - Scan all processes by command-line keywords
  - Collect CPU, memory, uptime for each matched process
  - Infer working/idle status from CPU activity
"""

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import psutil

AGENT_DEFINITIONS = [
    {
        "id": "opencode",
        "name": "OpenCode",
        "keywords": ["opencode"],
        "exclude_keywords": [
            "curl ",
            "python",
            "/bin/zsh",
            "/bin/bash",
            "| python",
            "json.tool",
        ],
    },
    {
        "id": "claude-code",
        "name": "Claude Code",
        "keywords": ["claude", "claude-code"],
        "exclude_keywords": ["Claude.app"],
    },
    {
        "id": "codex-cli",
        "name": "Codex CLI",
        "keywords": ["codex"],
        "exclude_keywords": [
            ".app/contents/",
            "/applications/chatgpt.app/",
            "com.openai.codex",
            "crashpad_handler",
            "codex (service)",
            "codex (renderer)",
            "codex (gpu)",
            "codex-code-mode-host",
            " app-server",
            "skycomputeruseservice",
            "curl ",
            "python",
            "/bin/zsh",
            "/bin/bash",
        ],
    },
    {
        "id": "codex-app",
        "name": "Codex App",
        "keywords": [
            "codex.app/contents/macos/codex",
            "chatgpt.app/contents/macos/chatgpt",
        ],
        "exclude_keywords": [
            "crashpad_handler",
            "codex (service)",
            "codex (renderer)",
            "codex (gpu)",
            "skycomputeruseservice",
        ],
    },
    {
        "id": "antigravity",
        "name": "Antigravity",
        "keywords": ["antigravity-cli", "antigravity", "antigravity_cli", "agy"],
        "exclude_keywords": [
            "curl ",
            "python",
            "/bin/zsh",
            "/bin/bash",
        ],
    },
]

STATUS_IDLE_THRESHOLD_CPU = 3.0
CODEX_INTERACTION_GRACE_SECONDS = 5.0
CODEX_SESSION_ACTIVE_SECONDS = 12 * 60 * 60
CODEX_SESSION_TAIL_BYTES = 2 * 1024 * 1024
CODEX_CLI_ORIGINATORS = {"codex_cli_rs", "codex-tui"}
CODEX_APP_ORIGINATORS = {"Codex Desktop"}
AGENT_INTERACTION_TAIL_BYTES = 2 * 1024 * 1024

_codex_interaction_cache: dict[str, tuple[float, bool]] = {}


@dataclass
class AgentSnapshot:
    agent_id: str
    display_name: str
    status: str
    pid: int
    cpu_percent: float
    memory_mb: float
    uptime_seconds: int
    command_line: str = ""


@dataclass
class AgentStatus:
    agent_id: str
    display_name: str
    status: str
    process_count: int
    total_cpu_percent: float
    total_memory_mb: float
    max_uptime_seconds: int
    processes: list = field(default_factory=list)


def _get_process_uptime(proc: psutil.Process) -> int:
    try:
        return int(time.time() - proc.create_time())
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0


def _infer_status(cpu_percent: float) -> str:
    if cpu_percent >= STATUS_IDLE_THRESHOLD_CPU:
        return "working"
    return "idle"


def _find_agent_processes(keywords: list[str], exclude_keywords: list[str] | None = None) -> list[psutil.Process]:
    found = []
    for proc in psutil.process_iter(["pid", "name"]):
        try:
            cmdline_parts = proc.cmdline()
            cmdline = " ".join(cmdline_parts).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied, PermissionError, SystemError):
            continue

        if not cmdline:
            continue

        matched = False
        for kw in keywords:
            kw_lower = kw.lower()
            if kw_lower in ("agy", "claude", "claude-code"):
                if any(
                    p.lower() == kw_lower or p.lower().endswith("/" + kw_lower)
                    for p in cmdline_parts
                ):
                    matched = True
                    break
            else:
                if kw_lower in cmdline:
                    matched = True
                    break
        if not matched:
            continue

        if exclude_keywords and any(kw.lower() in cmdline for kw in exclude_keywords):
            continue

        found.append(proc)
    return found


def _read_recent_lines(path: Path) -> list[str]:
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - AGENT_INTERACTION_TAIL_BYTES))
            if size > AGENT_INTERACTION_TAIL_BYTES:
                f.readline()
            return f.read().decode("utf-8", errors="ignore").splitlines()
    except OSError:
        return []


def _path_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _antigravity_log_needs_interaction(path: Path, pids: set[int]) -> bool:
    pid_strings = {str(value) for value in pids}
    tool_surface = -1
    tool_response = -1
    question_surface = -1
    question_response = -1

    for idx, line in enumerate(_read_recent_lines(path)):
        parts = line.split(maxsplit=3)
        if len(parts) < 4 or parts[2] not in pid_strings:
            continue

        if "Surfacing tool confirmation" in line:
            tool_surface = idx
        elif (
            "Responding to tool confirmation" in line
            or "Tool confirmation for conversation" in line
        ):
            tool_response = idx
        elif "Surfacing ask_question" in line:
            question_surface = idx
        elif "Forwarding user message to conversation" in line:
            question_response = idx

    return tool_surface > tool_response or question_surface > question_response


def _antigravity_log_paths(pid: int) -> tuple[list[Path], set[int]]:
    paths = []
    pids = {pid}
    started_at = 0.0
    try:
        process = psutil.Process(pid)
        started_at = process.create_time()
        processes = [process]
        processes.extend(process.children(recursive=True))
        for candidate in processes:
            pids.add(candidate.pid)
            for opened in candidate.open_files():
                path = Path(opened.path)
                if path.suffix == ".log" and path.name.startswith("cli-"):
                    paths.append(path)
    except (
        psutil.NoSuchProcess,
        psutil.AccessDenied,
        PermissionError,
        OSError,
        SystemError,
    ):
        pass

    log_dir = Path.home() / ".gemini" / "antigravity-cli" / "log"
    try:
        for path in log_dir.glob("cli-*.log"):
            if path.stat().st_mtime >= started_at - 5:
                paths.append(path)
    except OSError:
        pass

    unique_paths = sorted(
        set(paths),
        key=_path_mtime,
        reverse=True,
    )
    return unique_paths, pids


def _is_antigravity_paused(pid: int) -> bool:
    paths, pids = _antigravity_log_paths(pid)
    return any(_antigravity_log_needs_interaction(path, pids) for path in paths)


def _claude_session_needs_interaction(path: Path) -> bool:
    pending_questions = set()
    for line in _read_recent_lines(path):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        message = event.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue

        if message.get("role") == "assistant":
            for item in content:
                if (
                    isinstance(item, dict)
                    and item.get("type") == "tool_use"
                    and item.get("name") == "AskUserQuestion"
                ):
                    pending_questions.add(item.get("id") or event.get("uuid"))
        elif message.get("role") == "user":
            resolved = False
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "tool_result":
                    continue
                pending_questions.discard(item.get("tool_use_id"))
                resolved = True
            if pending_questions and content and not resolved:
                pending_questions.clear()

    return bool(pending_questions)


def _claude_session_paths(pid: int) -> list[Path]:
    paths = []
    started_at = 0.0
    project_dir = None
    try:
        process = psutil.Process(pid)
        started_at = process.create_time()
        for opened in process.open_files():
            path = Path(opened.path)
            if path.suffix == ".jsonl" and ".claude/projects" in path.as_posix():
                paths.append(path)
        cwd = process.cwd()
        project_dir = (
            Path.home()
            / ".claude"
            / "projects"
            / cwd.replace(os.sep, "-")
        )
    except (
        psutil.NoSuchProcess,
        psutil.AccessDenied,
        PermissionError,
        OSError,
        SystemError,
    ):
        pass

    projects_root = Path.home() / ".claude" / "projects"
    search_root = project_dir if project_dir and project_dir.is_dir() else projects_root
    try:
        pattern = "*.jsonl" if search_root == project_dir else "*/*.jsonl"
        for path in search_root.glob(pattern):
            if path.stat().st_mtime >= started_at - 5:
                paths.append(path)
    except OSError:
        pass

    return sorted(
        set(paths),
        key=_path_mtime,
        reverse=True,
    )


def _is_claude_code_paused(pid: int) -> bool:
    return any(
        _claude_session_needs_interaction(path)
        for path in _claude_session_paths(pid)
    )


def _is_opencode_paused(pid: int) -> bool:
    import os
    import psutil

    log_path = os.path.expanduser("~/.local/share/opencode/log/opencode.log")
    if not os.path.exists(log_path):
        return False

    try:
        # Check if this process actually has the opencode.log file open
        p = psutil.Process(pid)
        opens_log = False
        for f in p.open_files():
            if os.path.abspath(f.path) == os.path.abspath(log_path):
                opens_log = True
                break
        if not opens_log:
            return False
    except Exception:
        pass

    try:
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()

        recent_lines = lines[-2000:]

        run_states = {}
        for line in recent_lines:
            if "run=" not in line or "message=" not in line:
                continue

            parts = line.split()
            run_id = None
            for p in parts:
                if p.startswith("run="):
                    run_id = p.split("=")[1]
                    break
            if not run_id:
                continue

            if run_id not in run_states:
                run_states[run_id] = {}

            if "message=asking" in line:
                req_id = None
                for p in parts:
                    if p.startswith("id="):
                        req_id = p.split("=")[1]
                        break
                if req_id:
                    run_states[run_id][req_id] = "asking"
            elif "message=replied" in line or "message=rejected" in line or "message=resolved" in line:
                req_id = None
                for p in parts:
                    if p.startswith("requestID="):
                        req_id = p.split("=")[1]
                        break
                if req_id:
                    run_states[run_id][req_id] = "resolved"
            else:
                # Any other activity line for this run_id implicitly resolves
                # any preceding permission request (per_*) since the agent has moved forward
                for req_id in list(run_states[run_id].keys()):
                    if req_id.startswith("per_") and run_states[run_id][req_id] == "asking":
                        run_states[run_id][req_id] = "resolved"

        latest_run_id = None
        for line in reversed(recent_lines):
            parts = line.split()
            for p in parts:
                if p.startswith("run="):
                    latest_run_id = p.split("=")[1]
                    break
            if latest_run_id:
                break

        if latest_run_id and latest_run_id in run_states:
            for req_id, state in run_states[latest_run_id].items():
                if state == "asking":
                    return True

    except Exception:
        pass
    return False


def _parse_event_time(value: str, fallback: float) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return fallback


def _read_codex_session_events(path: Path) -> list[dict]:
    """Read the metadata line and recent tail of a Codex rollout."""
    try:
        with path.open("rb") as f:
            first_line = f.readline()
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - CODEX_SESSION_TAIL_BYTES))
            if size > CODEX_SESSION_TAIL_BYTES:
                f.readline()  # discard a partial JSONL record
            tail = f.read()
    except OSError:
        return []

    raw_lines = [first_line]
    raw_lines.extend(tail.splitlines())
    events: list[dict] = []
    seen = set()
    for raw in raw_lines:
        if not raw or raw in seen:
            continue
        seen.add(raw)
        try:
            events.append(json.loads(raw))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
    return events


def _codex_elicitation_resolved(thread_id: str, started_at: float) -> bool:
    """Return true once Desktop records a response to an approval prompt."""
    if not thread_id:
        return False
    db_path = Path.home() / ".codex" / "logs_2.sqlite"
    if not db_path.exists():
        return False
    try:
        uri = f"file:{db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=0.1)
        try:
            row = conn.execute(
                "SELECT 1 FROM logs "
                "WHERE thread_id = ? AND ts >= ? "
                "AND feedback_log_body LIKE '%ResolveElicitation%' LIMIT 1",
                (thread_id, int(started_at)),
            ).fetchone()
        finally:
            conn.close()
        return row is not None
    except (sqlite3.Error, OSError):
        return False


def _codex_session_needs_interaction(
    path: Path,
    now: Optional[float] = None,
    grace_seconds: float = CODEX_INTERACTION_GRACE_SECONDS,
    expected_agent_id: Optional[str] = None,
) -> bool:
    """Detect unanswered user-input or approval calls in a Codex rollout."""
    current_time = time.time() if now is None else now
    events = _read_codex_session_events(path)
    if not events:
        return False

    metadata = next((e for e in events if e.get("type") == "session_meta"), None)
    metadata_payload = (metadata or {}).get("payload", {})
    originator = metadata_payload.get("originator", "")
    source = metadata_payload.get("source", "")
    if originator in CODEX_CLI_ORIGINATORS or source == "cli":
        session_agent_id = "codex-cli"
    elif originator in CODEX_APP_ORIGINATORS:
        session_agent_id = "codex-app"
    else:
        return False
    if expected_agent_id is not None and session_agent_id != expected_agent_id:
        return False
    thread_id = metadata_payload.get("session_id") or metadata_payload.get("id", "")

    pending: dict[str, tuple[str, str, float]] = {}
    for event in events:
        payload = event.get("payload", {})
        event_type = event.get("type")
        payload_type = payload.get("type")

        if event_type == "event_msg" and payload_type in ("task_started", "task_complete"):
            pending.clear()
            continue

        if event_type != "response_item":
            continue

        call_id = payload.get("call_id")
        if not call_id:
            continue
        if payload_type in ("function_call_output", "custom_tool_call_output"):
            pending.pop(call_id, None)
            continue
        if payload_type not in ("function_call", "custom_tool_call"):
            continue

        pending[call_id] = (
            str(payload.get("name", "")),
            str(payload.get("input", payload.get("arguments", ""))),
            _parse_event_time(event.get("timestamp", ""), current_time),
        )

    for name, call_input, started_at in pending.values():
        age = max(0.0, current_time - started_at)
        if age > CODEX_SESSION_ACTIVE_SECONDS:
            continue
        if name == "request_user_input":
            return True
        if "require_escalated" in call_input:
            if age >= grace_seconds and not _codex_elicitation_resolved(thread_id, started_at):
                return True
            continue
        if age >= grace_seconds and (
            "mcp__" in call_input
            or "request_plugin_install" in call_input
        ):
            if not _codex_elicitation_resolved(thread_id, started_at):
                return True
    return False


def _recent_codex_sessions(now: Optional[float] = None) -> list[Path]:
    current_time = time.time() if now is None else now
    sessions_root = Path.home() / ".codex" / "sessions"
    paths: list[Path] = []
    for day_offset in (0, 1):
        day = datetime.now() - timedelta(days=day_offset)
        day_dir = sessions_root / day.strftime("%Y") / day.strftime("%m") / day.strftime("%d")
        try:
            candidates = day_dir.glob("rollout-*.jsonl")
            for path in candidates:
                try:
                    if current_time - path.stat().st_mtime <= CODEX_SESSION_ACTIVE_SECONDS:
                        paths.append(path)
                except OSError:
                    continue
        except OSError:
            continue
    return paths


def _is_codex_paused(agent_id: str) -> bool:
    now = time.time()
    cached_at, cached_value = _codex_interaction_cache.get(agent_id, (0.0, False))
    if now - cached_at < 1.0:
        return cached_value

    paused = any(
        _codex_session_needs_interaction(
            path,
            now=now,
            expected_agent_id=agent_id,
        )
        for path in _recent_codex_sessions(now)
    )
    _codex_interaction_cache[agent_id] = (now, paused)
    return paused


def _is_codex_cli_paused() -> bool:
    return _is_codex_paused("codex-cli")


def _is_codex_app_paused() -> bool:
    return _is_codex_paused("codex-app")


def collect_agent_status(agent_id: Optional[str] = None) -> list[AgentStatus]:
    results = []
    for defn in AGENT_DEFINITIONS:
        if agent_id and defn["id"] != agent_id:
            continue

        procs = _find_agent_processes(defn["keywords"], defn.get("exclude_keywords"))
        if not procs:
            continue

        snapshots: list[AgentSnapshot] = []
        for proc in procs:
            try:
                try:
                    cmdline_parts = proc.cmdline()
                    cmdline = " ".join(cmdline_parts)
                except (psutil.NoSuchProcess, psutil.AccessDenied, PermissionError, SystemError):
                    cmdline = ""
                cpu = proc.cpu_percent(interval=0.1)
                mem = proc.memory_info().rss / 1024 / 1024
                uptime = _get_process_uptime(proc)
                snapshots.append(AgentSnapshot(
                    agent_id=defn["id"],
                    display_name=defn["name"],
                    status=_infer_status(cpu),
                    pid=proc.pid,
                    cpu_percent=round(cpu, 1),
                    memory_mb=round(mem, 1),
                    uptime_seconds=uptime,
                    command_line=cmdline[:200],
                ))
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError, SystemError):
                continue

        total_cpu = round(sum(s.cpu_percent for s in snapshots), 1)
        total_mem = round(sum(s.memory_mb for s in snapshots), 1)
        max_uptime = max((s.uptime_seconds for s in snapshots), default=0)

        for s in snapshots:
            if defn["id"] == "antigravity" and _is_antigravity_paused(s.pid):
                s.status = "paused"
            elif defn["id"] == "claude-code" and _is_claude_code_paused(s.pid):
                s.status = "paused"
            elif defn["id"] == "opencode" and _is_opencode_paused(s.pid):
                s.status = "paused"
            elif defn["id"] == "codex-cli" and _is_codex_cli_paused():
                s.status = "paused"
            elif defn["id"] == "codex-app" and _is_codex_app_paused():
                s.status = "paused"

        if any(s.status == "paused" for s in snapshots):
            overall_status = "paused"
        else:
            overall_status = "working" if any(s.status == "working" for s in snapshots) else "idle"

        results.append(AgentStatus(
            agent_id=defn["id"],
            display_name=defn["name"],
            status=overall_status,
            process_count=len(snapshots),
            total_cpu_percent=total_cpu,
            total_memory_mb=total_mem,
            max_uptime_seconds=max_uptime,
            processes=[
                {
                    "pid": s.pid,
                    "cpu_percent": s.cpu_percent,
                    "memory_mb": s.memory_mb,
                    "uptime_seconds": s.uptime_seconds,
                    "status": s.status,
                    "command_line": s.command_line,
                }
                for s in snapshots
            ],
        ))

    return results


def agent_status_to_dict(agent: AgentStatus) -> dict:
    return asdict(agent)
