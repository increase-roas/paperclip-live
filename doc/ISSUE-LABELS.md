# Issue label taxonomy

Paperclip uses three label groups so agents and humans can filter work
programmatically. Apply the definitions in `.github/labels.yml` with the
repository label API or `gh label create`; the file is the source of truth.

## Priority

| Label | Meaning |
| --- | --- |
| `priority:p0` | Production outage, data loss, or security incident |
| `priority:p1` | Blocks a release or a large share of users |
| `priority:p2` | Important but has a workaround |
| `priority:p3` | Nice to have; schedule when capacity allows |

## Type

`type:bug`, `type:feature`, `type:chore`, `type:docs`, `type:security`,
`type:performance`, `type:test`, `type:dependencies`.

## Area

`area:server`, `area:ui`, `area:cli`, `area:runner`, `area:connectors`,
`area:skills`, `area:release`, `area:docs`, `area:infra`.

## Applying labels

```sh
# Requires repository admin; this is intentionally not run by agents.
gh label create "priority:p1" --color d93f0b --description "Blocks a release or many users" --force
```

The repository settings themselves are owned by maintainers. Agents may add
labels to issues they open when the taxonomy is present, but must not rename or
delete labels.
