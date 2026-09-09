<div align="center">

<img src="docs/assets/logo.png" alt="justpostgres" width="120" height="120">

# justpostgres

**A Postgres connection string, a table view, and a restore button.**<br>
Self-hosted, in one command.

<sub>
  <a href="docs/INSTALL.md">Install</a> ·
  <a href="docs/SECURITY.md">Security</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/ROADMAP.md">Roadmap</a>
</sub>

<br>

<sub>
  Postgres 16 · 17 · 18 &nbsp;|&nbsp; point-in-time restore &nbsp;|&nbsp; branching &nbsp;|&nbsp;
  connection pooling &nbsp;|&nbsp; backups to S3 or R2
</sub>

</div>

---

Most people reaching for Supabase or Appwrite want one thing: a fresh Postgres they can
connect to, a way to look at their data, and the confidence that they can get yesterday
back if they break something. What they get instead is a stack — auth, storage, realtime,
edge functions, an API gateway — that they have to operate whether or not they use it.

justpostgres is the small version. You run one command on a VPS, and you get:

- **Projects.** Click "new project", get a real Postgres with a connection string. Seconds, not minutes.
- **Superuser.** It's your database. `CREATE EXTENSION` works. `pgvector`, `PostGIS`, `pg_cron` are one click.
- **A table view.** Browse, filter, sort, edit rows inline. Run SQL with schema-aware completion,
  read query plans, export CSV. Paging uses keysets, so page 10,000 of a two-million-row table costs
  the same as page 1 — measured at 0.04 ms where `OFFSET` took 230 ms.
- **Point-in-time restore.** Not "here is last night's dump" — restore to 14:32 yesterday, into a *new*
  project, without touching the one that's running.
- **Backups that leave the box.** Point them at Cloudflare R2, S3, or any S3-compatible bucket from
  the settings page — it tells you where to find each value, tests the connection before saving, and
  moves existing projects across one at a time. Backups on the same disk as the database survive a
  dropped table and nothing else.
- **Branching.** Fork a project as of right now, or as of any point in your retention window. Test the
  migration on the branch, throw it away.
- **Pooling.** A direct connection string and a transaction-pooled one, so serverless clients don't
  exhaust your connections. Every project answers on one host and port — routed by TLS SNI
  (`your-project.db.example.com`) or by a `postgres.your-project` username, so no per-project DNS or
  firewall rules.
- **An optional REST API.** PostgREST over your schema when you want it, off by default — and when
  you turn it on, no table is reachable until you expose it. Exposing grants access and enables
  row-level security in one transaction, so "reachable but unprotected" is not a state you can reach
  by forgetting a step. Bring your own identity provider; we issue the keys, your policies do the
  deciding.

Open source, self-hosted first. A hosted service will follow, built on exactly this code.

## What it is not

Not a BaaS. There is no user-auth service, no file storage, no realtime engine, no edge
functions. If you want those, use Supabase — it's good, and this project is not trying to
replace it. justpostgres is for people who already decided they only wanted the database.

## Status

Pre-alpha. **M0–M7 are complete** — every feature milestone. Sign in, create a project, connect to a
real Postgres with a real superuser through one pooled endpoint, browse and query your data, restore
it to any point in its recovery window, branch it, turn on extensions, and put a REST API in front of
it.

**M8 (hardening) is most of the way there**: major-version upgrades, a disk-exhaustion policy,
storage verified at boot, control-plane backup and restore, per-project metrics, an audit log in the
UI, backups to S3 or R2 configured from the settings page, and an honest
[security review](docs/SECURITY.md). What is left before 1.0 is an automated test suite — there is
none yet — and the network-isolation fix described in that review.

## Install

All you need is Docker.

```bash
git clone https://github.com/justpostgres/justpostgres.git && cd justpostgres
echo "JP_MASTER_KEY=$(openssl rand -base64 32)" > .env   # keep this; it has no recovery
images/postgres/build.sh                                 # the project Postgres images
docker compose up -d --build
docker compose logs control-plane | grep jp_setup        # the one-time setup token
```

Open http://localhost:3000 and claim it with that token — there is no default account.

**[The install guide](docs/INSTALL.md)** has three complete walkthroughs, each self-contained:

| | |
|---|---|
| **[Run it locally](docs/INSTALL.md#a-run-it-locally)** | On your own machine, at `localhost:3000` |
| **[On a VPS, no domain](docs/INSTALL.md#b-run-it-on-a-vps-without-a-domain)** | Plain HTTP at `http://YOUR_IP:8080`, no certificate needed |
| **[On a VPS, with a domain](docs/INSTALL.md#c-run-it-on-a-vps-with-a-domain-and-https)** | `https://db.example.com`, certificate issued and renewed for you |

It also covers the firewall rule you should not skip, sending backups to S3 or R2, upgrades, and
what to do if you forget the administrator password.

- [Security](docs/SECURITY.md) — what is protected, what is not, and what you must decide
- [Architecture](docs/ARCHITECTURE.md) — how it works and why
- [Roadmap](docs/ROADMAP.md) — the path to 1.0

## Requirements

A Linux host with Docker. That's it. No Kubernetes.

### How much does a project cost you

Measured on arm64 with Docker Desktop, so treat these as the right order of magnitude rather than
your host's numbers:

| Thing | Memory | Notes |
|---|---|---|
| Control plane | ~110 MiB | One per host. Serves the API and the UI. |
| Router + pooler | ~44 MiB | One per host. Optional; projects also publish a direct port. |
| Idle project | 22–33 MiB | A Postgres container nobody is connected to. |
| Project in use | 55–76 MiB | Same containers, after real queries and a backup. |
| REST API, if enabled | ~100 MiB | **The most expensive part of a project.** See below. |

Read the idle number as a floor, not a capacity plan. Every client connection is a Postgres backend
process, `shared_buffers` grows the working set under real traffic, and what limits a host is
connections and working set — not idle footprint.

**What a 4 GB VPS actually holds.** Reserve ~1 GB for the host and the control plane. That leaves
roughly 3 GB, which is **20–30 lightly-used projects**, or **8–12 projects with the REST API on**, or
far fewer if any of them is genuinely busy. The per-project memory limit defaults to 512 MiB, so a
single project *can* take a sixth of that host on its own — which is the point of the limit.

**PostgREST is a Haskell program and its runtime does not return memory.** Measured at 35 MiB from
cold and 114 MiB after a few hours, against the 128 MiB limit it originally had — stable, but at 89%
of its ceiling, where one traffic burst gets it OOM-killed mid-request. Its heap is now bounded with
`GHCRTS=-M96m` inside a 192 MiB limit, which holds it at ~100 MiB under load with room to move, and
turns the failure mode from a silent kill into a logged heap overflow. Budget for it: turning the API
on roughly triples what a project costs.

Disk is the other limit, and the harder one. justpostgres keeps a reserve — the larger of 10% and
2 GB by default — and refuses to create projects, branches or restores below it, because Postgres
does not degrade when it cannot write, it stops. See `JP_DISK_MIN_FREE_PERCENT`.

## Development

Requires Node 22+ and pnpm 11+.

```bash
pnpm install
pnpm --filter @justpostgres/control-plane db:generate   # only after schema changes
pnpm dev            # control plane on :3000, UI on :5173 with /api proxied
```

Production build, served as one origin by the control plane:

```bash
pnpm build
JP_MASTER_KEY=$(openssl rand -base64 32) NODE_ENV=production \
  pnpm --filter @justpostgres/control-plane start
```

Or via Docker:

```bash
export JP_MASTER_KEY=$(openssl rand -base64 32)
docker compose up --build
```

Docker does not need to be running to develop the control plane. It reports the
runtime as unreachable and carries on — the same property that keeps the UI
available to explain an outage.

### First run: claiming the install

There is no default account and no default password. On first boot the control
plane prints a one-time setup token and keeps printing it on every boot until
someone claims the install:

```
docker compose logs control-plane | grep jp_setup
```

Open the UI, paste that token alongside the email and password you want, and the
admin account is created and the token destroyed. Without the token `/setup`
refuses — otherwise the first stranger to find the page owns your databases,
which is the failure mode of every "first visitor becomes admin" installer.

Set `JP_SETUP_TOKEN` if you would rather choose the value yourself, e.g. when a
configuration manager provisions the host and should hand the operator a token
it already knows.

### Layout

```
apps/control-plane   API, job runner, Docker driver, SQLite metadata store
apps/web             React UI, built into the control plane's static directory
apps/router          M2 — Postgres wire-protocol router and pooler
packages/shared      Types shared by the control plane and the UI
images/postgres      M1 — project Postgres images with pgBackRest baked in
```
