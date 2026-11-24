# ARI documentation

Start with the package [README](../README.md): install, the subpath table and
the two quickstarts.

| Document | What it covers |
|---|---|
| [`../spec/v1/README.md`](../spec/v1/README.md) | The normative contract: conventions, the event grammar and the wire protocol rules |
| [`wire.md`](wire.md) | `ari/wire` for host and client authors: framing, the handshake, streams, host services and what to do when a driver dies |
| [`conformance.md`](conformance.md) | Plugging a driver into `ari/conformance`, scenario applicability and the fixture format |
| [`effect.md`](effect.md) | `ari/effect`: services, streams, tagged errors and Effect schemas |
| [`drivers/`](drivers/) | One page per first-party driver: what it runs, its capabilities against the proposal, its quirks and tested versions |
| [`../clients/README.md`](../clients/README.md) | The Rust, Python and Go clients |
| [`../SECURITY.md`](../SECURITY.md) | Reporting a vulnerability, and how releases are built and published |
| [`../CHANGELOG.md`](../CHANGELOG.md), [`../changelogs/`](../changelogs/) | The package changelog and one changelog per driver |

The drivers:

| Driver | Page |
|---|---|
| `pi` | [drivers/pi.md](drivers/pi.md) |
| `acp` | [drivers/acp.md](drivers/acp.md) |
| `grok` | [drivers/grok.md](drivers/grok.md) |
| `fx` | [drivers/fx.md](drivers/fx.md) |
| `kiro` | [drivers/kiro.md](drivers/kiro.md) |
| `acp-registry` | [drivers/acp-registry.md](drivers/acp-registry.md) |
| `antigravity` | [drivers/antigravity.md](drivers/antigravity.md) |
| `codex` | [drivers/codex.md](drivers/codex.md) |
| `claude` | [drivers/claude.md](drivers/claude.md) |
| `opencode` | [drivers/opencode.md](drivers/opencode.md) |
| `cursor` | [drivers/cursor.md](drivers/cursor.md) |
| `muse` | [drivers/muse.md](drivers/muse.md) |
