# Real `--version` output of the vendor CLIs

Each file is what one vendor CLI prints for `--version` on stdout, byte for
byte. Each CLI driver's tests read its file and check that the driver's
version parser finds the version in it.

## Captured on the build machine, 2026-11-25

Each CLI ran only with `--version` (`grok` with `GROK_DISABLE_AUTOUPDATER=1`,
as the driver runs it); stderr was empty and every exit code was 0.

| File | Command | Installed at | Version read |
|---|---|---|---|
| `codex.txt` | `codex --version` | a mise shim for Codex CLI 0.172.0 | 0.172.0 |
| `muse.txt` | `muse --version` | Muse Code 1.4.7, installed with mise | 1.4.7 |
| `opencode-2.txt` | `opencode --version` | OpenCode 2.1.2, installed with mise | 2.1.2 |
| `grok.txt` | `grok --version` | Grok Build CLI 1.0.70, installed with mise | 1.0.70 |
| `agy.txt` | `agy --version` | a mise shim for the Antigravity CLI 1.5.17 | 1.5.17 |

## Taken from the vendor's source

These CLIs are not installed on the build machine, so their output comes from
the code that prints it.

| File | Version read | Source |
|---|---|---|
| `opencode-1.txt` | 1.19.6 | OpenCode 1.x prints the bare version: yargs' `.version("version", "show version number", InstallationVersion)` in `packages/opencode/src/index.ts` line 51, with `InstallationVersion` the build-time `OPENCODE_VERSION` (`packages/core/src/installation/version.ts`), set to the bare npm version (`packages/opencode/script/build.ts` line 195), at tag `v1.19.6`, commit `f4e363c8295fa90a03dddc451882fffe8fbce357` of https://github.com/anomalyco/opencode |
| `pi.txt` | 1.6.0 | `pi --version` runs `console.log(VERSION)` (`dist/main.js` lines 545 to 546 of `@earendil-works/pi-coding-agent` 1.6.0, the devDependency), with `VERSION = pkg.version` (`dist/config.js` line 493) |
| `fx.txt` | 0.0.17 | `fx --version` writes `cfg.version` and a newline (`src/core/cli/cli_surface.zig` lines 1543 to 1549; its test "runIfRequested version flags write configured version" expects `0.0.0\n` for version `0.0.0`), with `pub const version = "0.0.17"` (`src/main.zig` line 10), at tag `v0.0.17`, commit `d1d4a883382daf8f2e7447dc361978312cf403d2` of https://github.com/vercel-labs/fx |

## Taken from Kiro's official release

Kiro CLI is closed source. The [3.0 release notes](https://kiro.dev/changelog/cli/3-0/)
and [V3 guide](https://kiro.dev/docs/cli/v3/) identify the release and the
`kiro-cli --version` command. `kiro-cli.txt` is the command's exact stdout
from the vendor's [Linux x86-64 3.0.0 release archive](https://desktop-release.q.us-east-1.amazonaws.com/3.0.0/kirocli-x86_64-linux.zip)
(SHA-256 `83dd96e00a75937958096da0436703562bc8c841bef66bde00a4caa5494d8be8`).
Only the extracted `kirocli/bin/kiro-cli` ran, with `--version` and a scratch
HOME and XDG directories. It exited 0 with empty stderr; no installer ran.
