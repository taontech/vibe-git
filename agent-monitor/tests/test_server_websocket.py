import unittest
from unittest.mock import patch

from fastapi import WebSocketDisconnect

import server


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.messages = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, value):
        self.messages.append(value)

    async def receive(self):
        raise WebSocketDisconnect()


class StatusWebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_initial_snapshot_is_sent_and_socket_is_removed(self):
        socket = FakeWebSocket()
        snapshot = {"version": 42, "content_hash": "abc"}

        with patch("server.build_status_snapshot", return_value=snapshot):
            await server.status_websocket(socket)

        self.assertTrue(socket.accepted)
        self.assertEqual(socket.messages, [snapshot])
        self.assertNotIn(socket, server.STATUS_WEBSOCKETS)


if __name__ == "__main__":
    unittest.main()
