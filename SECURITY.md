# Security policy

ARI drivers spawn processes and handle credentials, so this package is
security-sensitive. Thank you for helping keep it safe.

## Reporting a vulnerability

Report a vulnerability privately through GitHub's private vulnerability
reporting: open the **Security** tab of this package's GitHub repository and
choose **Report a vulnerability**. Do not open a public issue, pull request or
discussion for it.

Please include:

- the affected package version, subpath and driver;
- what an attacker can do, and what they need first (for example a malicious
  agent binary on `PATH`, or a crafted wire frame);
- the steps or a small program that shows it.

A fix ships as a new release with a GitHub security advisory.

## Supported versions

Only the latest release gets security fixes. The package is not published yet;
this applies from its first release.

## Scope

In scope: everything in the npm package (`dist/` and `json-schema/`), the
`ari-driver` executables attached to GitHub releases, and the release
workflow. For example: a driver that leaks a secret into a child process's
environment or a log, a path from a session that escapes the
instance's directories, a host prompt a driver injects, or a wire frame that
crashes or takes over a host.

Out of scope: vulnerabilities in the vendor agents and SDKs the drivers run
(report those to the vendor), and in hosts that use ARI.

## How releases are built and published

These rules protect users from a compromised release:

- **Publish only from CI.** `.github/workflows/release.yml` publishes to npm
  with npm trusted publishing: GitHub Actions exchanges a short-lived OIDC
  token (`id-token: write`) for the publish, so no long-lived npm token exists.
  Trusted publishing needs npm CLI 11.5.1 or later and Node 22.14.0 or later,
  and runs only on GitHub-hosted runners.
- **Provenance on every release.** The workflow runs
  `npm publish --provenance`, so each version carries a signed SLSA provenance
  statement that links the tarball to this repository, the workflow file and
  the commit it was built from. Check an installed copy with
  `npm audit signatures`.
- **Turn off token publishing.** Once trusted publishing works, the package's
  npm settings use "Require two-factor authentication and disallow tokens", as
  npm recommends.
- **No runtime dependencies.** `dependencies` in `package.json` stays empty,
  and the release fails if it is not. Vendor SDKs and `effect` are optional
  peers that the user installs.
- **The tested tarball is the published tarball.** The release job runs the
  full gate, packs the package once with `scripts/pack.ts`, checks that
  tarball's own `package.json`, and publishes that file.
- **Pinned actions.** Every action the workflows use is pinned to a full
  commit SHA.
- **Release binaries carry checksums.** The standalone `ari-driver`
  executables are attached to the GitHub release with a `SHA256SUMS` file.
- **Signed tags and a changelog.** Each release is cut from a signed tag and
  described in `CHANGELOG.md` and the per-driver changelogs in `changelogs/`.
- **A size budget.** The gate fails when the root export grows past the byte
  budget in `scripts/size-budget.json`.
