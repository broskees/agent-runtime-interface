"""`ari-client`: drive an ARI driver over `ari/wire`, newline-delimited JSON-RPC 2.0 on the stdio
of an `ari-driver` process (the standalone executable needs no Node).

The wire models, one async method per call a host makes (`Client.session_start_turn`, ...) and the
`Host` base class with one method per call a driver makes (`host/*`) are generated from ARI's
`json-schema/` and `spec/v1/methods.json` into `_generated.py`. `_client.py` holds only the
framing.

Every tagged union (`AriEventBody`, `CallError`, `ContentBlock`, ...) decodes a variant this client
does not know, such as an `x:` extension event, as `Unrecognized<Union>` with its raw JSON, and
every enum keeps an unknown value as a member whose `recognized` is false.
"""

from ._client import Client, MemoryHost
from ._codec import UNSET, AriCallError, OpenEnum, Unset, WireDecodeError, encode
from ._generated import *  # noqa: F403
from ._subscription import Subscription


