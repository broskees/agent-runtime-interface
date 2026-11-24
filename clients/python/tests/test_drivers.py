"""The Python client drives the real `pi` and `acp` drivers inside the standalone `ari-driver`
(built by `pnpm run build:binary` into build/standalone/linux-x64/), with a PATH that holds no
`node` and no `bun`: initialize, probe the instance, open a session, create a thread, start a
turn, answer its approval through `respond`, and read events until `turn.terminal` completes."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import ari_client as ari

STANDALONE = Path(os.environ.get("ARI_STANDALONE_DIR", Path(__file__).resolve().parents[3] / "build" / "standalone" / "linux-x64"))


def binary(relative: str) -> str:
    path = STANDALONE / relative
    assert path.is_file(), f"{path} is missing; run `pnpm run build:binary` first"
    return str(path.resolve())


class NodeFree:
    """A temp directory with bin/ (only `pi`, the compiled fake), home/, project/ and the instance's state/, cache/ and tmp/."""

    def __init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="ari-python-client-")).resolve()
        for directory in ["bin", "home", "project", "state", "cache", "tmp"]:
            (self.root / directory).mkdir()
        (self.root / "bin" / "pi").symlink_to(binary("fakes/pi"))
        for runtime in ["node", "nodejs", "bun"]:
            assert shutil.which(runtime, path=self.path("bin")) is None, f"the PATH must hold no {runtime}"

    def path(self, relative: str) -> str:
        return str(self.root / relative)

    def env(self) -> dict[str, str]:
        """Only PATH (no node, no bun), HOME and XDG dirs."""
        home = self.path("home")
        return {
            "PATH": self.path("bin"),
            "HOME": home,
            "XDG_CONFIG_HOME": f"{home}/.config",
            "XDG_DATA_HOME": f"{home}/.local/share",
            "XDG_STATE_HOME": f"{home}/.local/state",
            "XDG_CACHE_HOME": f"{home}/.cache",
        }

    def remove(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


async def complete_a_turn(driver: str, config: dict[str, Any], option_id: str, expected_version: str) -> None:
    place = NodeFree()
    try:
        instance_key = f"{driver}-python"
        host = ari.MemoryHost().with_config(instance_key, config)
        client = await ari.Client.spawn(binary("ari-driver"), driver, host=host, env=place.env(), cwd=place.path("project"))
        try:
            handshake = await client.initialize(ari.EnvPolicy(strip_ambient=[]))
            assert handshake.driver.kind == driver
            assert handshake.grammar_version == 1

            instance = await client.driver_create(
                ari.DriverCreateParams(instance_id=instance_key, config=config, environment={}, paths=ari.HostPaths(state_dir=place.path("state"), cache_dir=place.path("cache"), tmp_dir=place.path("tmp")))
            )
            probe = await client.instance_probe(ari.InstanceProbeParams(instance_id=instance.instance_id))
            assert probe.installed, probe
            assert probe.version == expected_version

            session = await client.instance_open_session(ari.InstanceOpenSessionParams(instance_id=instance.instance_id))
            events = await client.session_events(ari.SessionEventsParams(session_id=session.session_id))
            project = place.path("project")
            policy = ari.RuntimePolicy(mode=ari.RuntimeMode.APPROVAL_REQUIRED, interaction=ari.InteractionMode.DEFAULT, cwd=project)
            thread = await client.session_create_thread(ari.SessionCreateThreadParams(session_id=session.session_id, cwd=project, policy=policy))
            started = await client.session_start_turn(
                ari.SessionStartTurnParams(session_id=session.session_id, thread_id=thread.id, client_turn_key="python-1", intent=ari.StartTurnIntent.START, content=[ari.TextContent(text="Say hello")])
            )
            assert isinstance(started, ari.StartTurnResultAccepted), started

            async def until_terminal() -> tuple[ari.TurnTerminalBody, str | None]:
                answered = None
                async for event in events:
                    body = event.body
                    if isinstance(body, ari.RequestUpsertBody) and body.request.status == ari.RequestStatus.PENDING:
                        options = body.request.options or []
                        assert any(option.option_id == option_id for option in options), options
                        await client.session_respond(ari.SessionRespondParams(session_id=session.session_id, request_id=body.request.id, response_key="python-answer", option_id=option_id))
                        answered = body.request.id
                    elif isinstance(body, ari.TurnTerminalBody):
                        return body, answered
                raise AssertionError("the event stream ended before turn.terminal")

            terminal, answered = await asyncio.wait_for(until_terminal(), 20)
            assert terminal.turn_id == started.turn_id
            assert terminal.status == ari.TurnTerminalStatus.COMPLETED
            assert answered is not None, "the approval request reached the client and was answered"

            await client.session_close(ari.SessionTarget(session_id=session.session_id))
            await client.instance_dispose(ari.InstanceTarget(instance_id=instance.instance_id))
        finally:
            await client.close()
        assert not (place.root / "home" / ".pi").exists(), "the fake pi wrote under the user's ~/.pi"
    finally:
        place.remove()


def test_pi_completes_a_turn_with_an_approval_without_node() -> None:
    asyncio.run(complete_a_turn("pi", {"binary": "pi", "provider": "fake", "model": "fake/fake-small"}, "allow-once", "1.6.0"))


def test_acp_completes_a_turn_with_an_approval_without_node() -> None:
    config = {"command": binary("fakes/standalone-acp-agent"), "args": [], "env": {}, "versionArgs": ["--version"], "maxProtocolVersion": 1, "forkAcrossDirectories": False, "configDependencies": {}}
    asyncio.run(complete_a_turn("acp", config, "allow", "1.0.0"))
