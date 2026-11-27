# Third-party notices

This file is for the standalone `ari-driver` executables that each GitHub
release attaches (`ari-driver-<platform>`). The npm package `ari` holds only
ARI's own code.

ARI's own code is under the MIT License; see [`LICENSE`](LICENSE). The MIT
License does not cover the third-party code below.

## `@anthropic-ai/claude-agent-sdk` 0.3.330

Each standalone `ari-driver` includes the JavaScript of the Claude Agent SDK,
`@anthropic-ai/claude-agent-sdk` version 0.3.330, so that its `claude`
driver runs without Node. The SDK's licence (its `LICENSE.md`) reads:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal
> Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

The executables hold none of the SDK's platform packages
(`@anthropic-ai/claude-agent-sdk-<platform>`) and no copy of Claude Code.
The `claude` driver runs the user's own Claude Code.
