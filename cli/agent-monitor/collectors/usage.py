"""
Usage/quota fetcher for opencode and codex.

Opencode: reads local SQLite database at ~/.local/share/opencode/opencode.db
           → today / this month / all-time cost and token stats

Codex:    reuses OAuth token from ~/.codex/auth.json
           → GET https://chatgpt.com/backend-api/wham/usage

No extra login required. Tokens never leave this machine.
"""

import base64
import json
import sqlite3
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Optional


@dataclass
class UsageWindow:
    label: str
    used_percent: Optional[float] = None
    cost_cents: Optional[int] = None
    sessions: Optional[int] = None
    tokens_input: Optional[int] = None
    tokens_output: Optional[int] = None
    limit_seconds: int = 0
    reset_seconds: int = 0


@dataclass
class ProviderUsageResult:
    provider: str
    status: str
    plan: Optional[str] = None
    windows: list[UsageWindow] = field(default_factory=list)
    fetched_at: Optional[float] = None
    error: Optional[str] = None


def _decode_jwt_payload(jwt_str: str) -> dict:
    parts = jwt_str.split(".")
    if len(parts) < 2:
        return {}
    b64 = parts[1].replace("-", "+").replace("_", "/")
    b64 += "=" * (4 - len(b64) % 4)
    try:
        return json.loads(base64.b64decode(b64))
    except Exception:
        return {}


def _http_get(url: str, headers: dict, timeout: int = 20) -> tuple[Optional[bytes], int]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.status
    except urllib.error.HTTPError as e:
        return e.read(), e.code
    except Exception:
        return None, 0


class UsageFetcher:
    def __init__(self):
        self._lock = Lock()
        self._opencode: Optional[ProviderUsageResult] = None
        self._codex: Optional[ProviderUsageResult] = None
        self._claude: Optional[ProviderUsageResult] = None
        self._antigravity: Optional[ProviderUsageResult] = None
        self._fetching = False
        self._last_fetch = 0.0
        self._min_interval = 60

    @property
    def needs_refresh(self) -> bool:
        return time.time() - self._last_fetch > self._min_interval

    def refresh(self, force: bool = False):
        if not force and not self.needs_refresh:
            return
        with self._lock:
            if self._fetching:
                return
            self._fetching = True

        try:
            self._opencode = self._fetch_opencode()
            codex = self._fetch_codex()
            # A short network interruption should not replace useful quota data.
            # Authentication and other persistent errors still surface normally.
            if not (
                self._codex is not None
                and self._codex.status == "ok"
                and codex.error == "Codex 用量请求网络失败"
            ):
                self._codex = codex
            self._claude = self._fetch_claude()
            self._antigravity = self._fetch_antigravity()
        finally:
            with self._lock:
                self._last_fetch = time.time()
                self._fetching = False

    def to_dict(self) -> dict:
        def wd(w: UsageWindow) -> dict:
            d: dict = {"label": w.label}
            if w.used_percent is not None:
                d["used_percent"] = w.used_percent
            if w.cost_cents is not None:
                d["cost_cents"] = w.cost_cents
            if w.sessions is not None:
                d["sessions"] = w.sessions
            if w.tokens_input is not None:
                d["tokens_input"] = w.tokens_input
            if w.tokens_output is not None:
                d["tokens_output"] = w.tokens_output
            if w.limit_seconds:
                d["limit_seconds"] = w.limit_seconds
            if w.reset_seconds:
                d["reset_seconds"] = w.reset_seconds
            return d

        def pd(p: Optional[ProviderUsageResult]) -> dict:
            if p is None:
                return {"status": "pending"}
            d: dict = {"status": p.status}
            if p.plan:
                d["plan"] = p.plan
            if p.windows:
                d["windows"] = [wd(w) for w in p.windows]
            if p.fetched_at:
                d["fetched_at"] = p.fetched_at
            if p.error:
                d["error"] = p.error
            return d

        return {
            "opencode": pd(self._opencode),
            "codex": pd(self._codex),
            "claude": pd(self._claude),
            "antigravity": pd(self._antigravity),
        }

    # ── Opencode (local SQLite) ──────────────────────────────────

    @staticmethod
    def _opencode_db_path() -> Optional[Path]:
        path = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
        if path.exists():
            return path
        return None

    def _fetch_opencode(self) -> ProviderUsageResult:
        result = ProviderUsageResult(provider="opencode", status="error")
        db_path = self._opencode_db_path()
        if not db_path:
            result.error = "未找到 opencode 数据库"
            return result

        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
        except Exception as e:
            result.error = f"无法打开 opencode 数据库: {e}"
            return result

        import datetime
        now = datetime.datetime.now()
        start_of_day = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        start_of_month = int(now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)

        base_sql = (
            "SELECT COUNT(*) as sessions, "
            "CAST(ROUND(SUM(cost) * 100) AS INTEGER) as cost_cents, "
            "SUM(tokens_input) as tokens_input, "
            "SUM(tokens_output) as tokens_output "
            "FROM session "
        )

        try:
            # today
            row = conn.execute(base_sql + "WHERE time_created >= ? AND time_created > 0", (start_of_day,)).fetchone()
            if row:
                result.windows.append(UsageWindow(
                    label="today",
                    cost_cents=row["cost_cents"] or 0,
                    sessions=row["sessions"] or 0,
                    tokens_input=row["tokens_input"] or 0,
                    tokens_output=row["tokens_output"] or 0,
                ))

            # this month
            row = conn.execute(base_sql + "WHERE time_created >= ? AND time_created > 0", (start_of_month,)).fetchone()
            if row:
                result.windows.append(UsageWindow(
                    label="month",
                    cost_cents=row["cost_cents"] or 0,
                    sessions=row["sessions"] or 0,
                    tokens_input=row["tokens_input"] or 0,
                    tokens_output=row["tokens_output"] or 0,
                ))

            # all time
            row = conn.execute(base_sql + "WHERE time_created > 0").fetchone()
            if row:
                result.windows.append(UsageWindow(
                    label="total",
                    cost_cents=row["cost_cents"] or 0,
                    sessions=row["sessions"] or 0,
                    tokens_input=row["tokens_input"] or 0,
                    tokens_output=row["tokens_output"] or 0,
                ))

            result.status = "ok"
            result.fetched_at = time.time()

            # Try to read plan/model from the most recent session
            try:
                row = conn.execute(
                    "SELECT model FROM session WHERE time_created > 0 ORDER BY time_created DESC LIMIT 1"
                ).fetchone()
                if row and row["model"]:
                    model_data = json.loads(row["model"]) if isinstance(row["model"], str) else {}
                    if isinstance(model_data, dict):
                        result.plan = model_data.get("id") or model_data.get("providerID")
            except Exception:
                pass
        except Exception as e:
            result.error = f"查询 opencode 用量失败: {e}"
        finally:
            conn.close()

        return result

    # ── Codex (remote API) ────────────────────────────────────────

    @staticmethod
    def _codex_credentials() -> Optional[tuple[str, str]]:
        auth_file = Path.home() / ".codex" / "auth.json"
        if not auth_file.exists():
            return None
        try:
            data = json.loads(auth_file.read_text())
            tokens = data.get("tokens", {})
            access_token = tokens.get("access_token", "")
            if not access_token:
                return None

            account_id = tokens.get("account_id", "")
            if not account_id:
                id_token = tokens.get("id_token", "")
                if id_token:
                    claims = _decode_jwt_payload(id_token)
                    auth_claim = claims.get("https://api.openai.com/auth", {})
                    account_id = auth_claim.get("chatgpt_account_id", "")
            return (access_token, account_id) if access_token else None
        except Exception:
            return None

    @staticmethod
    def _window_label(seconds: int) -> str:
        if seconds >= 2592000 * 0.8:
            return "30d"
        if seconds >= 604800 * 0.8:
            return "7d"
        if seconds >= 86400 * 0.8:
            return "24h"
        if seconds >= 18000 * 0.8:
            return "5h"
        hours = seconds // 3600
        if hours >= 24:
            return f"{seconds // 86400}d"
        return f"{hours}h"

    def _fetch_codex(self) -> ProviderUsageResult:
        result = ProviderUsageResult(provider="codex", status="error")
        creds = self._codex_credentials()
        if not creds:
            result.error = "未找到 Codex 登录凭据 (~/.codex/auth.json)"
            return result

        access_token, account_id = creds

        url = "https://chatgpt.com/backend-api/wham/usage"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": "AIClockBridge",
        }
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id

        data, code = _http_get(url, headers)
        if data is None:
            result.error = "Codex 用量请求网络失败"
            return result
        if code in (401, 403):
            result.error = "Codex 凭据过期，运行 codex 重新登录"
            return result
        if code not in range(200, 300):
            result.error = f"Codex 用量接口 HTTP {code}"
            return result

        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            result.error = "Codex 用量响应解析失败"
            return result

        result.status = "ok"
        result.plan = obj.get("plan_type") or obj.get("chatgpt_plan_type")

        now = time.time()
        rate_limit = obj.get("rate_limit", {})

        for window_key in ["primary_window", "secondary_window"]:
            if w := rate_limit.get(window_key):
                used = w.get("used_percent")
                limit_secs = w.get("limit_window_seconds", 0)
                if isinstance(w.get("reset_at"), (int, float)):
                    reset_secs = max(0, int(w["reset_at"] - now))
                elif isinstance(w.get("reset_after_seconds"), (int, float)):
                    reset_secs = w["reset_after_seconds"]
                else:
                    reset_secs = 0

                if used is not None:
                    result.windows.append(UsageWindow(
                        label=self._window_label(limit_secs),
                        used_percent=float(used),
                        limit_seconds=limit_secs,
                        reset_seconds=reset_secs,
                    ))

        result.fetched_at = time.time()
        return result

    def _fetch_claude(self) -> ProviderUsageResult:
        result = ProviderUsageResult(provider="claude", status="error")
        
        # Check active model/provider from ~/.claude/settings.json
        settings_path = Path.home() / ".claude" / "settings.json"
        if settings_path.exists():
            try:
                settings_data = json.loads(settings_path.read_text())
                model_name = settings_data.get("env", {}).get("ANTHROPIC_MODEL") or settings_data.get("model")
                if model_name:
                    result.plan = model_name
            except Exception:
                pass

        global_config_path = Path.home() / ".claude.json"
        if not global_config_path.exists():
            result.error = "未找到 Claude Code 全局配置文件"
            return result

        try:
            data = json.loads(global_config_path.read_text())
            projects = data.get("projects", {})
            total_input = 0
            total_output = 0
            total_cost = 0.0
            session_ids = set()
            
            for proj_path, proj_info in projects.items():
                if not isinstance(proj_info, dict):
                    continue
                session_id = str(proj_info.get("lastSessionId") or "").strip()
                session_key = session_id or f"project:{proj_path}"
                has_usage = any(
                    proj_info.get(key) is not None
                    for key in ("lastCost", "lastTotalInputTokens", "lastTotalOutputTokens")
                )
                if not has_usage or session_key in session_ids:
                    continue
                session_ids.add(session_key)
                total_input += proj_info.get("lastTotalInputTokens") or 0
                total_output += proj_info.get("lastTotalOutputTokens") or 0
                total_cost += proj_info.get("lastCost") or 0

            result.status = "ok"
            result.windows.append(UsageWindow(
                label="project_last_sessions",
                cost_cents=round(total_cost * 100),
                sessions=len(session_ids),
                tokens_input=total_input,
                tokens_output=total_output
            ))
            result.fetched_at = time.time()
        except Exception as e:
            result.error = f"读取 Claude Code 配置失败: {e}"

        return result

    def _fetch_antigravity(self) -> ProviderUsageResult:
        result = ProviderUsageResult(provider="antigravity", status="ok")
        gemini_dir = Path.home() / ".gemini" / "antigravity-cli"
        if not gemini_dir.exists():
            result.status = "error"
            result.error = "未找到 Antigravity 配置"
            return result

        result.plan = "Antigravity"
        result.fetched_at = time.time()

        history_file = gemini_dir / "history.jsonl"
        if history_file.exists():
            import datetime
            now = datetime.datetime.now()
            start_of_day_ms = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
            today_sessions = set()
            total_sessions = set()
            try:
                with open(history_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            item = json.loads(line)
                            if item.get("type") == "slash_command":
                                continue
                            ts = item.get("timestamp", 0)
                            if ts > 0:
                                conversation_id = str(item.get("conversationId") or "").strip()
                                if conversation_id:
                                    session_key = f"conversation:{conversation_id}"
                                else:
                                    workspace = str(item.get("workspace") or "").strip()
                                    session_key = f"legacy:{workspace}:{ts}"
                                total_sessions.add(session_key)
                                if ts >= start_of_day_ms:
                                    today_sessions.add(session_key)
                        except Exception:
                            pass
                result.windows.append(UsageWindow(label="today", sessions=len(today_sessions)))
                result.windows.append(UsageWindow(label="total", sessions=len(total_sessions)))
            except Exception:
                pass
        return result


_global_fetcher: Optional[UsageFetcher] = None
_fetcher_lock = Lock()


def get_usage_fetcher() -> UsageFetcher:
    global _global_fetcher
    with _fetcher_lock:
        if _global_fetcher is None:
            _global_fetcher = UsageFetcher()
        return _global_fetcher


def fetch_usage() -> dict:
    fetcher = get_usage_fetcher()
    fetcher.refresh()
    return fetcher.to_dict()
