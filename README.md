# ari

ARI (Agent Runtime Interface) is a provider-neutral runtime contract for apps
that drive coding agents. It is one standalone package with zero runtime
dependencies.

> `ari` is a working name. This package is under construction and is not
> published yet.

## Install

```bash
npm install ari
```

Node 22.16 or later. The root export is browser-safe. TypeScript consumers need
`moduleResolution` set to `node16`, `nodenext` or `bundler`.

## What is in it

| Import | What it is | Status |
|---|---|---|
| `ari` | The contract: wire types, validators, call errors, patch and capability helpers, and the `Driver`, `Instance`, `Session` and `HostServices` interfaces | available |
| `ari/json-schema/*.json` | The wire contract as JSON Schema draft 2020-12, plus `methods.json` | available |
| `ari/host`, `ari/driver-kit`, `ari/node`, `ari/wire`, `ari/conformance`, `ari/effect`, `ari/drivers/<name>`, `ari/meta/<name>`, `ari/cli-manifests` | Host toolkit, driver kit, Node host services, the stdio wire, conformance kit, Effect bindings, drivers and metadata | planned |

## Validate wire data

Every schema definition has a validator that implements
[Standard Schema](https://standardschema.dev/schema) v1 and
[Standard JSON Schema](https://standardschema.dev/json-schema) v1.

```ts
import { AriEventSchema } from "ari";

const result = AriEventSchema["~standard"].validate(incoming);
if (result.issues) {
  console.error(result.issues);
}
```

Unknown enum values and `x:` extension variants validate and come back
unchanged, so newer drivers never break older hosts.

## The contract

The normative contract is the JSON Schema under `spec/v1/` in the repository;
its README defines the conventions, the event grammar and the wire protocol.
TypeScript types and validators are generated from it.

## License

MIT
