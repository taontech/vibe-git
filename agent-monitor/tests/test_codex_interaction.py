import json
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone
from pathlib import Path

from collectors.agents import (
    AGENT_DEFINITIONS,
    _codex_session_needs_interaction,
    _find_agent_processes,
    collect_agent_status,
)


class CodexInteractionTests(unittest.TestCase):
    def make_rollout(self, events, originator="Codex Desktop", source=None):
        temp = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
        metadata_payload = {"originator": originator, "session_id": "codex-thread"}
        if source is not None:
            metadata_payload["source"] = source
        metadata = {
            "timestamp": "2026-07-12T08:00:00Z",
            "type": "session_meta",
            "payload": metadata_payload,
        }
        for event in [metadata, *events]:
            temp.write(json.dumps(event) + "\n")
        temp.close()
        self.addCleanup(Path(temp.name).unlink)
        return Path(temp.name)

    def test_pending_user_input_is_paused(self):
        path = self.make_rollout([{
            "timestamp": "2026-07-12T08:00:01Z",
            "type": "response_item",
            "payload": {"type": "function_call", "name": "request_user_input", "call_id": "ask-1"},
        }])
        now = datetime(2026, 7, 12, 8, 0, 2, tzinfo=timezone.utc).timestamp()
        self.assertTrue(_codex_session_needs_interaction(path, now=now))

    def test_output_resolves_user_input(self):
        path = self.make_rollout([
            {
                "timestamp": "2026-07-12T08:00:01Z",
                "type": "response_item",
                "payload": {"type": "function_call", "name": "request_user_input", "call_id": "ask-1"},
            },
            {
                "timestamp": "2026-07-12T08:00:03Z",
                "type": "response_item",
                "payload": {"type": "function_call_output", "call_id": "ask-1"},
            },
        ])
        now = datetime(2026, 7, 12, 8, 0, 4, tzinfo=timezone.utc).timestamp()
        self.assertFalse(_codex_session_needs_interaction(path, now=now))

    def test_slow_mcp_call_uses_grace_period(self):
        path = self.make_rollout([{
            "timestamp": "2026-07-12T08:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "mcp-1",
                "input": "await tools.mcp__example__read({});",
            },
        }])
        early = datetime(2026, 7, 12, 8, 0, 3, tzinfo=timezone.utc).timestamp()
        late = datetime(2026, 7, 12, 8, 0, 8, tzinfo=timezone.utc).timestamp()
        self.assertFalse(_codex_session_needs_interaction(path, now=early, grace_seconds=5))
        self.assertTrue(_codex_session_needs_interaction(path, now=late, grace_seconds=5))

    def test_resolved_approval_is_not_paused_while_tool_keeps_running(self):
        path = self.make_rollout([{
            "timestamp": "2026-07-12T08:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "approval-1",
                "input": 'sandbox_permissions: "require_escalated"',
            },
        }])
        now = datetime(2026, 7, 12, 8, 0, 8, tzinfo=timezone.utc).timestamp()
        with patch("collectors.agents._codex_elicitation_resolved", return_value=True):
            self.assertFalse(_codex_session_needs_interaction(path, now=now))

    def test_cli_pending_user_input_is_paused(self):
        path = self.make_rollout([{
            "timestamp": "2026-07-12T08:00:01Z",
            "type": "response_item",
            "payload": {"type": "function_call", "name": "request_user_input", "call_id": "ask-1"},
        }], originator="codex-tui", source="cli")
        now = datetime(2026, 7, 12, 8, 0, 2, tzinfo=timezone.utc).timestamp()
        self.assertTrue(_codex_session_needs_interaction(path, now=now))

    def test_legacy_cli_arguments_support_approval_detection(self):
        path = self.make_rollout([{
            "timestamp": "2026-07-12T08:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "approval-1",
                "arguments": '{"sandbox_permissions":"require_escalated"}',
            },
        }], originator="codex_cli_rs")
        now = datetime(2026, 7, 12, 8, 0, 8, tzinfo=timezone.utc).timestamp()
        self.assertTrue(_codex_session_needs_interaction(path, now=now, grace_seconds=5))

    def test_client_filter_keeps_cli_and_app_status_separate(self):
        path = self.make_rollout([{
            "timestamp": "2026-07-12T08:00:01Z",
            "type": "response_item",
            "payload": {"type": "function_call", "name": "request_user_input", "call_id": "ask-1"},
        }], originator="codex-tui", source="cli")
        now = datetime(2026, 7, 12, 8, 0, 2, tzinfo=timezone.utc).timestamp()
        self.assertTrue(_codex_session_needs_interaction(
            path,
            now=now,
            expected_agent_id="codex-cli",
        ))
        self.assertFalse(_codex_session_needs_interaction(
            path,
            now=now,
            expected_agent_id="codex-app",
        ))

    def test_collector_marks_codex_cli_as_paused(self):
        process = MagicMock(pid=1234)
        process.cmdline.return_value = ["codex"]
        process.cpu_percent.return_value = 0.0
        process.memory_info.return_value.rss = 64 * 1024 * 1024

        with (
            patch("collectors.agents._find_agent_processes", return_value=[process]),
            patch("collectors.agents._get_process_uptime", return_value=10),
            patch("collectors.agents._is_codex_cli_paused", return_value=True),
        ):
            statuses = collect_agent_status("codex-cli")

        self.assertEqual(len(statuses), 1)
        self.assertEqual(statuses[0].status, "paused")
        self.assertEqual(statuses[0].processes[0]["status"], "paused")

    def test_codex_cli_filter_ignores_extension_app_server(self):
        cli_process = MagicMock(pid=1234)
        cli_process.cmdline.return_value = ["codex", "--cd", "/tmp/project"]
        app_server_process = MagicMock(pid=5678)
        app_server_process.cmdline.return_value = [
            "/path/to/openai.chatgpt/bin/codex",
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--analytics-default-enabled",
        ]
        codex_definition = next(
            definition
            for definition in AGENT_DEFINITIONS
            if definition["id"] == "codex-cli"
        )

        with patch(
            "collectors.agents.psutil.process_iter",
            return_value=[cli_process, app_server_process],
        ):
            processes = _find_agent_processes(
                codex_definition["keywords"],
                codex_definition["exclude_keywords"],
            )

        self.assertEqual([process.pid for process in processes], [1234])


if __name__ == "__main__":
    unittest.main()
