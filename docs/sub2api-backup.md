# Sub2API data backups

## Boundary

FinOps manages settings and job history in its own database. It never stores the
production PostgreSQL administrator credentials. There is no restore endpoint,
restore target configuration, drill scheduler, Redis export or Sub2API backup API.

The dedicated worker receives cloud credentials over the private Docker network.
The worker has neither the Docker socket nor production PostgreSQL data volumes.
A root-owned, fixed-command host exporter provides read-only exports over a Unix
socket mounted only into the worker. Existing local PostgreSQL access is used;
no roles, grants, extensions, triggers, replication slots or server settings are changed.
The existing administrator access is NOT a least-privilege database account.
SQL sessions and pg_dump use default_transaction_read_only, bounded statement
and lock timeouts. Ordinary source writes continue; scans can still consume I/O,
and long snapshots can delay vacuum. Do not promise zero performance impact.

## Deployment

Use both Compose files under the existing `deploy` project:

```sh
docker compose --env-file /etc/apistation-finops/finops.env \
  -f deploy/docker-compose.host.yml -f deploy/docker-compose.backup.yml build
```

Generate distinct random secrets (never commit them) in the server-only env file:

- `FINOPS_BACKUP_CREDENTIALS_KEY`: 32 random bytes encoded as 64 hex characters.
- `FINOPS_BACKUP_WORKER_TOKEN`: at least 32 random characters, shared by FinOps and worker.
- `FINOPS_BACKUP_WORKER_URL=http://finops-backup-worker:8093`

Install `deploy/finops-backup-source.service` as a separate systemd service.
The default source is the existing `1Panel-postgresql-ggpg` container, database
`sub2api`. Inspect these names before installation. The exporter socket is
`/run/finops-backup-source/export.sock`, owned by worker UID 1000, mode 0600.
Only this new exporter service is started; do not restart Sub2API, PostgreSQL or Redis.
Migration 076 creates only FinOps backup settings/job tables in the isolated FinOps DB.
Use `up -d --no-deps apistation-finops finops-backup-worker`, never `down` on production.
Export statements have a 10-minute timeout and the host export has a fixed
25-minute ceiling, in addition to the configurable overall worker timeout.

Automatic backup and retention cleanup both default OFF. Updating FinOps does not
start a business-data export or upload before the user configures/enables it.

## First use

Open `/backups`, save private Qiniu bucket/region/dedicated repository prefix,
scoped access credentials, and a strong Restic repository password. Passwords are
encrypted at rest with the deployment key, never returned by GET, and blanks
preserve existing secrets. An existing repository password cannot be arbitrarily
replaced: use the original password or a separate new repository prefix.
AK and SK are different values from the same Qiniu key pair. Identical values
are rejected before saving or contacting cloud storage, including legacy saved
credentials. The access fields use separate names and disable password autofill;
check both values if a browser password manager fills them automatically.

Use source inspection, initialize ONLY the dedicated empty repository, test the
repository, then run the first backup. Retain the repository password, matching DDL
and external application encryption/configuration independently of this server.
Do not share production SSH or database credentials through the settings page.

Qiniu S3 endpoint/region compatibility and scoped permissions must be verified
with the actual user-provided bucket; a saved form is not proof of a usable backup.
Use the documented regional endpoint, for example `https://s3.cn-south-1.qiniucs.com`
with region `cn-south-1`. The bucket is a separate field: do not paste its
`<bucket>.s3.<region>.qiniucs.com` domain into the regional endpoint field. Legacy
hyphenated endpoints remain accepted for existing configurations, but are not
selected by default or silently rewritten. Endpoint changes still require confirmation.
See https://developer.qiniu.com/kodo/4088/s3-access-domainname.

Storage failures return fixed, categorized messages, never raw CLI diagnostics or
credentials. `Access Denied` does not prove that the repository is uninitialized
or that the repository password is wrong: cloud authentication/authorization failed
before those could be verified. Re-enter a matching AK/SK pair in FinOps, not chat.
Do not initialize, force-unlock, or overwrite a repository to fix authentication.

## Data format and increments

The reviewed `sub2api-core-v1` public-table profile is fixed in `backup-source.py`.
Users, balances, credentials, configuration, orders, financial audit and billing
deduplication are included. Operational/request logs are excluded. Rows of
usage_logs referenced by included business foreign keys are exported from the
SAME snapshot. Unknown new tables, excluded FK dependencies and unsupported
partition/sequence layouts stop export pending code review, rather than silently
losing data. FinOps schemas, DDL, indexes and physical database pages are excluded.

The coordinator holds one REPEATABLE READ READ ONLY snapshot; pg_dump imports that
snapshot for data-only export, and required usage rows use it too. Sequence state
is read without nextval. Destination-only safe sequence floors are appended.
A final nonce marker is written only after all exports succeed. The worker rejects
truncated dumps and missing table COPY sections before invoking Restic.

Each run scans/exports selected source data: this is NOT incremental source
reading, CDC, a transaction history, arbitrary-time PITR, or a complete system clone.
Restic performs chunk deduplication, compression and encryption. With repository
format v2, its default automatic compression compresses new blocks before encryption
and upload. Do not gzip the whole SQL file first: changes in one part of a compressed
stream can impair deduplication of otherwise unchanged data. Unchanged cloud blocks
are reused by new self-contained snapshot manifests. Plain staging files are private
to the worker volume (0700/0600) and removed after each attempt; that temporary
volume is not itself encrypted by this feature. Do not give other processes access.

Job history is paginated (20 rows by default, selectable 10/20/50/100), not limited
to the latest 100 jobs. The active task and latest successful task are queried
independently of the selected page. `addedBytes` is Restic's deduplicated, uncompressed
new blob size (`data_added`), not upload traffic. New jobs also record
`addedPackedBytes` (`data_added_packed`), the compressed added blob size. This is not
exact wire traffic or Qiniu billable usage: pack/index/snapshot overhead, requests
and retries are separate. Historical records without this metric display no value;
they are never estimated from raw sizes.

Restic stages encrypted upload packs in private per-command directories under
`/var/lib/finops-backup/tmp` on the disk-backed worker volume. They must not use
the container's 64 MiB `/tmp` tmpfs: concurrent uploads can exhaust it even when
the server disk has free space. Directories are removed after each command exits;
startup removes leftovers from an interrupted worker. Allow disk space for both
the uncompressed source export and in-flight encrypted packs/cache.
Fatal JSON errors from Restic stdout and stderr are classified without exposing
raw diagnostics. Local disk exhaustion is reported separately from cloud authentication.

The worker confirms the committed cloud snapshot and runs Restic repository
metadata checks before reporting success. This does not prove a database restore
and does not read back every data block. No actual restore is performed automatically.
Loss window is measured from the last successfully recoverable source snapshot,
not upload completion. Schedule plus runtime is only an estimate; failures extend it.

Optional retention uses `forget --group-by host` and `prune`, filtered to this
source/tag. Source-time/schema tags must NOT create independent retention groups.
Cleanup failure is a warning on an already verified backup. Never configure cloud
age-based lifecycle deletion: old shared blocks may be required by new snapshots.
No automatic force-unlock, repository reinitialization, or overwrite is performed.

## Independent recovery

The cloud-points tab reads the repository itself, not only FinOps job records.
Select a point to stream a full plaintext TAR package. The worker uses `restic dump`
to fetch the needed cloud blocks on demand, decrypt and reconstruct the selected
snapshot, and stream the TAR through FinOps to the browser. No prebuilt TAR is
downloaded or retained on the server in advance. The package contains `data.sql`,
`manifest.json` (source time, counts, checksum, schema fingerprint and exclusions),
`validate.sql`, `SHA256SUMS` and `RESTORE.md`. Treat downloads as highly sensitive.
`data.sql` is a PostgreSQL data-only script (COPY data and sequence state), not DDL
or an index backup. There is no need to manually assemble an incremental chain.
Verify download hashes.

Restore only to an isolated EMPTY PostgreSQL 15 database with matching precreated
DDL, following RESTORE.md. Destination-only triggers are temporarily bypassed
inside one transaction and explicit FK checks run before commit. Do not connect
the restored application to real payment, email, upstream or production endpoints.
Redis sessions and unfinished Redis-backed image tasks are not in this backup.
Retain matching DDL and external app secrets separately; fingerprints are not DDL.

If FinOps or its DB is lost, use the independently retained cloud credentials and
Restic password with `restic snapshots` and `restic restore`. The cloud repository
contains the recovery metadata and instructions, not only FinOps DB references.

## Synthetic integration check

On a Linux Docker host, build `deploy/Dockerfile.backup` with tag
`apistation-finops-backup:review`, then run `python3 test/backup-linux-integration.py`.
This opt-in test creates disposable PostgreSQL and worker containers with synthetic
rows, no published ports, no production mounts and no cloud connection. It checks
fixed source exports, referenced usage, empty tables, two backup runs, local Restic
deduplication/check/retention, full TAR download and hashes. It performs no database
restore. Containers and synthetic files are removed in the test's finally block.

For the upload-space regression, run `test/backup-restic-linux-integration.mjs`
inside a disposable review-image container with `--network none --read-only`,
`--tmpfs /tmp:size=64m,mode=1777` and a fresh disk-backed volume mounted at
`/var/lib/finops-backup`. Mount the fixture file read-only and run it with Node.
It uses 192 MiB of random synthetic data and a slow loopback-only storage server:
the old tmpfs path must fail, while the production disk path must commit a
snapshot, pass repository checks and remove temporary pack directories.
