# Release facts for the updater

Every release gets a signed `release-manifest.json`
(`.github/workflows/release-manifest.yml`, `scripts/release/make_manifest.py`).
Most of it is worked out from the tag: images, digests, pins, the Alembic
head. What only the person cutting the release knows goes in
`release/<version>.json` **at the tag**, e.g. `release/0.2.0.json`:

```json
{
  "min_upgrade_from": "0.1.8",
  "manual_steps": [
    {"id": "new-nats-token", "text": "Run ./scripts/generate-secrets.sh --write to add NATS_APPS_TOKEN to .env."}
  ],
  "urgent": false,
  "state_migrations": false
}
```

| Field | Meaning for every site |
|---|---|
| `min_upgrade_from` | Oldest version that may update straight to this one. Older sites are told to take an intermediate release first. Leave it out when any version may. |
| `manual_steps` | Something the operator must do (a new required secret, a changed port). Automatic updates skip a release that has any; a manual update shows them and stops. |
| `urgent` | A security fix: automatic updates install it at the next maintenance window without the usual random delay. |
| `state_migrations` | This release changes data outside the database (recording layout, volume formats). It is never rolled back automatically, because putting the old database back would not put the old files back. |
| `notes_url` | Defaults to the GitHub release page. |

No file means none of these apply.
