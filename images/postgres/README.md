# Project Postgres images

The image every project runs: the official Postgres image plus pgBackRest and a
curated extension set, installed but not enabled.

```bash
./build.sh          # 16, 17 and 18
./build.sh 17       # just one
```

The control plane resolves an image per project from
`JP_POSTGRES_IMAGE_TEMPLATE` (default `justpostgres/postgres:{major}`) and pins
it on the project row at creation, so changing the default later cannot silently
move an existing project onto a different image.

## What's in it

| | Why |
|---|---|
| `pgbackrest` | M4 needs `archive_command` to invoke it, and that runs as a subprocess of Postgres — so it has to be in this container, not a sidecar. |
| `pgvector` | The most requested extension by a wide margin. |
| `pg_cron` | In-database scheduling. Needs `shared_preload_libraries`, so enabling it restarts the container. |
| `pg_stat_statements` | Ships with the official image's contrib. Powers the query stats in M8. Also needs a preload. |
| `postgis` | Added in M6. The earlier decision to exclude it on size grounds was wrong: the image is pulled once per host and shared by every project, so the 254 MB is paid once, not per project. |

TimescaleDB is still absent: it needs a third-party apt repository and only its
Apache-licensed subset is redistributable here.

## Not published yet

There is no registry push. Until there is, a major version has to be built
locally before a project can be created on it, or `JP_POSTGRES_IMAGE_TEMPLATE`
pointed at something that exists (`postgres:{major}` works, minus the
extensions).
