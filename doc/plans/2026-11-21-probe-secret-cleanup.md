# Cleanup plan: `probe-perm` and `probe-perm2`

Status: **already removed; no action needed.** This records what they were, where
any trace remains, and what a removal would affect.

## What they were

Two `local_encrypted` secrets created in the Increase Roas company during the
tool-access permission probes on 2026-11-21. They held throwaway values and were
used to verify that secret creation and deletion obey board/agent permissions.
They were never attached to a connection, grant, agent or routine.

## Current state (read from the live database, read-only)

| Query | Result |
| --- | --- |
| `company_secrets` where name matches `probe-perm%` | **0 rows** |
| `tool_access_audit_events` mentioning `probe-perm` | **0 rows** |
| `activity_log` mentioning `probe-perm` | **4 rows**: 2 `secret.created`, 2 `secret.deleted` |

Activity rows (append-only history):

| Activity id | Action | Secret entity |
| --- | --- | --- |
| `eb505369-8a59-4258-aff3-864d1e643966` | `secret.created` | `1e91e084-6688-4950-a54a-0d7fe533f8ce` (`probe-perm`) |
| `8b532367-c09f-4097-aca8-5573ec79670a` | `secret.created` | `71abc536-50e1-455b-8399-97024f49b5c1` (`probe-perm2`) |
| `bbacd09e-18ea-49cc-becc-0419fdf430b3` | `secret.deleted` | `1e91e084-…` |
| `ffd899a2-3fa7-4842-8074-7136d98aab73` | `secret.deleted` | `71abc536-…` |

The vault ciphertext was removed with the rows; no value survives in
`company_secrets`. The four activity rows are the only remaining trace.

## What removing them affects

- **Nothing functional.** No connection, grant, catalog entry or agent references
  either id.
- The activity rows are written by the control plane as an audit trail. Deleting
  them would remove evidence that the probe happened, not remove a secret.
- Backups taken while the secrets existed may still contain the encrypted rows;
  the values were throwaway and encryption keys are not in the snapshots.

## Recommended cleanup

**Do nothing to the database.** The secrets are gone; the history should stay.

Optional, if Alex wants the trace named somewhere durable: keep this document as
the record and leave `activity_log` untouched.

## If a probe secret ever reappears

1. Find it: `select id, name, created_at from company_secrets where name ilike 'probe-perm%';`
2. Delete through the API so the deletion is recorded:
   `DELETE /api/secrets/<id>` with a board key.
3. Re-run the query from “Current state”; expect 0 rows and two new
   `secret.deleted` activity rows.

Do not delete rows from `activity_log` or `company_secrets` with SQL; that skips
the audit record and the vault cleanup.

## Rollback

Not applicable: nothing is being removed. If this document is wrong and a row is
found, the API delete above is reversible only by creating a new secret with the
same name; the old value is gone by design.
