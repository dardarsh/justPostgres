# syntax=docker/dockerfile:1
#
# The image every project runs.
#
# The official Postgres image plus pgBackRest and a curated extension set,
# installed but not enabled — `CREATE EXTENSION` is the user's call, made from
# the UI in M6.
#
# pgBackRest is baked in rather than run as a sidecar, and that is forced
# rather than chosen: `archive_command` executes as a subprocess of the Postgres
# process, so the archiving binary has to live in this container. It also halves
# the container count, which matters when the whole design is
# container-per-project. Nothing configures it until M4; it ships now so that
# enabling backups later does not require rebuilding every project's image.

ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-bookworm

ARG PG_MAJOR
LABEL org.opencontainers.image.title="justpostgres-postgres" \
      org.opencontainers.image.description="Postgres ${PG_MAJOR} with pgBackRest and curated extensions" \
      org.opencontainers.image.source="https://github.com/justpostgres/justpostgres"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        pgbackrest \
        postgresql-${PG_MAJOR}-pgvector \
        postgresql-${PG_MAJOR}-cron \
        postgresql-${PG_MAJOR}-postgis-3 \
        postgresql-${PG_MAJOR}-postgis-3-scripts \
        btrfs-progs \
    ; \
    rm -rf /var/lib/apt/lists/*

# btrfs-progs is here so this same image can double as the privileged helper
# that snapshots a project's data directory for a copy-on-write branch (M5).
# Shipping one image rather than two means the helper is always present and
# always the right version, at a cost of a few megabytes.

# PostGIS was originally left out over image size. That reasoning was wrong: the
# image is pulled once per *host* and shared by every project on it, so the cost
# is paid once rather than per project. A geospatial database that cannot do
# geospatial work without rebuilding its image is the worse trade.
#
# TimescaleDB is still absent. It needs a third-party apt repository, and only
# its Apache-licensed subset is redistributable here — enough moving parts that
# it belongs in a deliberate follow-up rather than bundled in quietly.

# pg_isready is what the control plane polls to decide a project is ready, so
# the image declares the same check for anything else watching.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -q || exit 1
