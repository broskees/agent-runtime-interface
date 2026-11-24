# Changelog: fx driver

## Unreleased

- Added the fx driver (`ari/drivers/fx`, `ari/meta/fx`): the fx agent as an
  ACP agent, `fx acp`.
- fx's model option depends on its provider option (`dependsOn: ["provider"]`)
  on every option list fx sends.
- Tested range `>=0.0.13 <0.0.18` (fx 0.0.13 to 0.0.17), with an
  `untested_version` advisory outside it.
