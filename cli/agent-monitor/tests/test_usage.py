import json
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from collectors.usage import UsageFetcher


class UsageFetcherTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.home = Path(self.temp_dir.name)

    def test_claude_aggregates_unique_latest_project_sessions(self):
        config = {
            "projects": {
                "project-a": {
                    "lastSessionId": "shared-session",
                    "lastCost": 0.10,
                    "lastTotalInputTokens": 10,
                    "lastTotalOutputTokens": 1,
                },
                "project-a-alias": {
                    "lastSessionId": "shared-session",
                    "lastCost": 9.99,
                    "lastTotalInputTokens": 999,
                    "lastTotalOutputTokens": 999,
                },
                "project-b": {
                    "lastSessionId": "second-session",
                    "lastCost": 0.20,
                    "lastTotalInputTokens": 20,
                    "lastTotalOutputTokens": 2,
                },
                "project-without-usage": {
                    "lastSessionId": "empty-session",
                },
            }
        }
        (self.home / ".claude.json").write_text(json.dumps(config))

        with patch("collectors.usage.Path.home", return_value=self.home):
            result = UsageFetcher()._fetch_claude()

        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.windows), 1)
        window = result.windows[0]
        self.assertEqual(window.label, "project_last_sessions")
        self.assertEqual(window.sessions, 2)
        self.assertEqual(window.cost_cents, 30)
        self.assertEqual(window.tokens_input, 30)
        self.assertEqual(window.tokens_output, 3)

    def test_antigravity_counts_conversations_instead_of_history_rows(self):
        history_dir = self.home / ".gemini" / "antigravity-cli"
        history_dir.mkdir(parents=True)
        now_ms = int(time.time() * 1000)
        start_of_day_ms = int(
            datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
        )
        yesterday_ms = start_of_day_ms - 1000
        rows = [
            {"timestamp": now_ms - 3000, "conversationId": "conversation-a"},
            {"timestamp": now_ms - 2000, "conversationId": "conversation-a"},
            {"timestamp": now_ms - 1000, "conversationId": "conversation-b"},
            {"timestamp": yesterday_ms, "conversationId": "conversation-c"},
            {"timestamp": now_ms - 500, "workspace": "legacy-project"},
            {"timestamp": now_ms - 400, "type": "slash_command"},
        ]
        history = "\n".join(json.dumps(row) for row in rows) + "\n"
        (history_dir / "history.jsonl").write_text(history)

        with patch("collectors.usage.Path.home", return_value=self.home):
            result = UsageFetcher()._fetch_antigravity()

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [(window.label, window.sessions) for window in result.windows],
            [("today", 3), ("total", 4)],
        )


if __name__ == "__main__":
    unittest.main()
