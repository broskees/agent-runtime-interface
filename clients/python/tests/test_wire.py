"""Framing rules and forward compatibility, against a scripted driver on a socket pair: events of a
type this client does not know (`x:vendor.ping`, and `session.hibernated` from a newer ARI) reach
the `UnrecognizedAriEventBody` catch-all with their raw JSON instead of failing the stream; the
client answers the driver's `host/*` requests while its own call is pending; items sent in the same
buffer as the response that starts their stream are not lost; and a driver that goes away fails the
pending call with `transport`."""

from __future__ import annotations

import asyncio
import json
import socket
from typing import Any

import pytest

import ari_client as ari


class ScriptedDriver:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader = reader
        self.writer = writer

    async def read(self) -> dict[str, Any]:
        line = await asyncio.wait_for(self.reader.readline(), 5)
        assert line, "the client closed the connection"
        return json.loads(line)

    async def write(self, *frames: dict[str, Any]) -> None:
        """Writes all frames in one write, so the client reads them from one buffer."""
        self.writer.write("".join(json.dumps(frame) + "\n" for frame in frames).encode())
        await self.writer.drain()


async def connect(host: ari.Host) -> tuple[ari.Client, ScriptedDriver]:
    client_socket, driver_socket = socket.socketpair()
    client_reader, client_writer = await asyncio.open_connection(sock=client_socket)
    driver_reader, driver_writer = await asyncio.open_connection(sock=driver_socket)
    return ari.Client(client_reader, client_writer, host), ScriptedDriver(driver_reader, driver_writer)


def handshake_result() -> dict[str, Any]:
    return {
        "ariVersion": ari.ARI_VERSION,
        "grammarVersions": [1, 1],
        "methodVersions": {name: {"major": major, "minor": minor} for name, (major, minor) in ari.METHOD_VERSIONS.items()},
        "persistenceVersion": {"major": 1, "minor": 0},
        "grammarVersion": 1,
        "driver": {"kind": "scripted", "ariVersion": ari.ARI_VERSION, "metadata": {"displayName": "Scripted", "multipleInstances": False, "hasDefaultInstance": False}, "configSchema": True},
    }


async def initialized(host: ari.Host) -> tuple[ari.Client, ScriptedDriver]:
    client, driver = await connect(host)
    handshake = asyncio.create_task(client.initialize(ari.EnvPolicy(strip_ambient=["SECRET_*"])))
    initialize = await driver.read()
    assert initialize["method"] == "initialize"
    assert initialize["params"]["host"] == {"capabilities": {"process": False}, "envPolicy": {"stripAmbient": ["SECRET_*"]}}
    assert initialize["params"]["methodVersions"]["session/startTurn"] == {"major": 1, "minor": 0}
    await driver.write({"jsonrpc": "2.0", "id": initialize["id"], "result": handshake_result()})
    await handshake
    return client, driver


def test_unknown_event_types_reach_the_catch_all_and_known_ones_still_decode() -> None:
    async def run() -> None:
        client, driver = await initialized(ari.MemoryHost())
        subscribe = asyncio.create_task(client.session_events(ari.SessionEventsParams(session_id="s-1")))
        request = await driver.read()
        assert request["method"] == "session/events"
        ping = {"type": "x:vendor.ping", "data": {"n": 1}, "fallback": {"title": "Ping"}}
        hibernated = {"type": "session.hibernated", "until": "tomorrow"}

        def event(seq: int, body: dict[str, Any]) -> dict[str, Any]:
            return {"jsonrpc": "2.0", "method": "ari/event", "params": {"streamId": "d1", "event": {"seq": seq, "at": "2026-11-23T00:00:00.000Z", "sessionId": "s-1", "body": body}}}

        await driver.write(
            {"jsonrpc": "2.0", "id": request["id"], "result": {"streamId": "d1"}},
            event(1, ping),
            event(2, hibernated),
            event(3, {"type": "turn.terminal", "turnId": "t-1", "status": "paused", "threadDisposition": "reusable"}),
            {"jsonrpc": "2.0", "method": "stream/end", "params": {"streamId": "d1"}},
        )
        events = [event async for event in await subscribe]
        assert len(events) == 3
        assert isinstance(events[0].body, ari.UnrecognizedAriEventBody)
        assert events[0].body.raw == ping
        assert events[0].body.tag == "x:vendor.ping"
        assert isinstance(events[1].body, ari.UnrecognizedAriEventBody)
        assert events[1].body.raw == hibernated
        terminal = events[2].body
        assert isinstance(terminal, ari.TurnTerminalBody)
        # An unknown enum value is kept too.
        assert terminal.status == "paused" and not terminal.status.recognized
        # And everything goes back on the wire as it came.
        assert ari.encode(events[0].body) == ping
        assert events[2].to_json()["body"]["status"] == "paused"
        await client.close()

    asyncio.run(run())


def test_the_host_answers_the_driver_while_a_call_is_pending() -> None:
    async def run() -> None:
        host = ari.MemoryHost().with_config("i-1", {"binary": "x"})
        client, driver = await initialized(host)
        call = asyncio.create_task(client.instance_probe(ari.InstanceProbeParams(instance_id="i-1")))
        probe = await driver.read()
        assert probe["method"] == "instance/probe"
        # Before answering, the driver asks the host for four things.
        await driver.write(
            {"jsonrpc": "2.0", "id": 1, "method": "host/config.get", "params": {"instanceId": "i-1", "watch": True}},
            {"jsonrpc": "2.0", "id": 2, "method": "host/secrets.get", "params": {"instanceId": "i-1", "namespace": "n", "key": "k"}},
            {"jsonrpc": "2.0", "id": 3, "method": "host/process.spawn", "params": {"instanceId": "i-1", "processId": "p1", "command": "x", "purpose": "probe"}},
            {"jsonrpc": "2.0", "id": 4, "method": "host/diagnostics.log", "params": {"instanceId": "i-1", "level": "warn", "msg": "hello"}},
        )
        answers: dict[int, dict[str, Any]] = {}
        config_stream_end = None
        while len(answers) < 4 or config_stream_end is None:
            frame = await driver.read()
            if frame.get("method") == "stream/end":
                config_stream_end = frame["params"]["streamId"]
            else:
                answers[frame["id"]] = frame
        assert answers[1]["result"]["config"] == {"binary": "x"}
        # A watch is answered with a stream that ends at once.
        assert config_stream_end == answers[1]["result"]["streamId"]
        assert answers[2]["result"] is None
        assert answers[3]["error"]["data"]["code"] == "unsupported"
        assert answers[4]["result"] is None
        assert host.diagnostics[0].msg == "hello"
        await driver.write({"jsonrpc": "2.0", "id": probe["id"], "result": {"ok": True, "installed": True, "checkedAt": "2026-11-23T00:00:00.000Z"}})
        result = await call
        assert result.installed
        await client.close()

    asyncio.run(run())


def test_a_driver_that_goes_away_fails_pending_calls_with_transport() -> None:
    async def run() -> None:
        client, driver = await initialized(ari.MemoryHost())
        call = asyncio.create_task(client.instance_status(ari.InstanceTarget(instance_id="i-1")))
        request = await driver.read()
        assert request["method"] == "instance/status"
        driver.writer.close()
        with pytest.raises(ari.AriCallError) as failure:
            await call
        assert failure.value.code == "transport"
        with pytest.raises(ari.AriCallError) as later:
            await client.instance_status(ari.InstanceTarget(instance_id="i-1"))
        assert later.value.code == "transport"
        await client.close()

    asyncio.run(run())


def test_call_errors_and_unknown_codes_round_trip() -> None:
    unsupported = ari.decode_call_error({"code": "unsupported", "message": "no", "capability": "threads.fork"})
    assert isinstance(unsupported, ari.UnsupportedError) and unsupported.capability == "threads.fork"
    extension = {"code": "x:vendor.quota", "message": "slow down", "detail": 3}
    decoded = ari.decode_call_error(extension)
    assert isinstance(decoded, ari.UnrecognizedCallError) and decoded.raw == extension
    assert ari.encode(decoded) == extension
