# router

The data path. Every project reaches its clients through here.

```
psql / app ──▶ :5432  session mode      one client, one server connection, relayed
               :6543  transaction mode  server connections pooled across clients
```

## How a connection finds its project

Three mechanisms, in preference order, because self-hosted deployments differ in what DNS and TLS
they have available:

| | Form | Needs |
|---|---|---|
| SNI | `<ref>.db.example.com:5432` | wildcard cert + wildcard DNS |
| Username prefix | user `postgres.<ref>` | nothing |
| Container port | `host:<project port>` | nothing; bypasses the router |

The third needs no code here — it is what you get by connecting straight to the container. It is also
how the router itself reaches a backend, and the permanent fallback if the router is ever a problem.

Neither the hostname nor the username is trusted. The ref is only a lookup key; the routing table
decides whether it names a real project. That matters for the username especially, since a client
holds superuser on its own database and can create a role called anything.

## Session vs transaction mode

**Session mode** relays authentication straight to Postgres. The router never sees the password, and
after the first `ReadyForQuery` it stops parsing entirely and pipes raw bytes. Rewriting the startup
username is safe: Postgres resolves the role from the startup packet, while SCRAM's proof is computed
over the SASL exchange.

**Transaction mode** cannot do that. A pooled server connection is opened before any particular client
asks for it and shared afterwards, so there is no client whose authentication could be relayed — the
router implements SCRAM-SHA-256 on both sides. It also has to frame every message to see
`ReadyForQuery`, which is where its throughput goes.

The standard transaction-pooling contract applies: nothing that lives in a session survives past a
transaction. `SET`, `LISTEN`, session advisory locks, `WITH HOLD` cursors and named prepared
statements all break. The UI hands out both strings side by side with that caveat attached, so the
choice is informed rather than a guess.

## Why it reads SQLite directly

The router does not ask the control plane for routes over HTTP. It reads the same metadata store,
read-only. Every project is unreachable while the router is down, so the router must not also go down
when the control plane is restarting, upgrading, or crashed.

## Performance

Measured against PgBouncer in M2 — see [ROADMAP](../../docs/ROADMAP.md). Roughly: 54–65% of PgBouncer
on simple protocol, 38% on extended protocol, +1.72 ms p99 over a direct connection. The extended
number is the weak one, and the reason this is a separate process and image: swapping in a compiled
implementation touches nothing else.

## Known gaps

- TLS terminates here; the router-to-Postgres hop is plaintext. Fine on one host, not fine across
  machines.
- md5 authentication to a backend is unsupported in pooled mode (scram-sha-256 only). Session mode
  relays whatever Postgres asks for, so it is unaffected.
- Passwords are not SASLprep-normalised. Every generated password is ASCII, where SASLprep is the
  identity; a hand-set non-ASCII password would fail in pooled mode.
- Client startup parameters other than `user` and `database` are not tracked per client in pooled
  mode, since server connections are shared.
