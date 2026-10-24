# MMBOT private deployment (offline / air-gapped)

This directory ships MMBOT as a Docker deployment for intranet and offline hosts: one script prepares an offline bundle on a connected machine, one script imports it on the target, `compose.offline.yml` runs it without ever pulling images, and `check.mjs` verifies the result. Models come from any OpenAI-compatible gateway; the key stays in the container environment and is never written to disk.

Files: `compose.offline.yml`, `install.sh` (prepare / load / config / check), `check.mjs`, `proxy/nginx.conf` (optional TLS termination), `.env.example`.

## Quick start

```bash
cp deploy/.env.example deploy/.env   # fill in the model gateway settings
bash deploy/install.sh prepare       # connected machine: build + export the offline bundle
# copy deploy/offline/* to the target, then there:
bash deploy/install.sh load
docker compose -f deploy/compose.offline.yml --env-file deploy/.env up -d
bash deploy/install.sh check
```

The full guide — prerequisites, the model gateway variables, the reverse proxy and TLS, data volumes and backups, upgrades and rollback, and a troubleshooting table — is in [README.zh.md](README.zh.md) (Chinese is the primary document).
