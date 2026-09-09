/**
 * Deciding which address a request really came from.
 *
 * `X-Forwarded-For` is a header, which means it is whatever the client typed.
 * Trusting it unconditionally was a real bypass here: the login lockout is
 * keyed on the client address, so an attacker sending a different forged value
 * on each attempt was never rate limited at all — verified, eight failed
 * logins with no lockout where six from one address locks the account.
 *
 * The rule is the standard one: believe the header only when the connection
 * itself came from a proxy the operator has named. With no trusted proxies
 * configured — the default, and correct for a control plane on loopback — the
 * header is ignored entirely and the socket address is used.
 */

export interface TrustedProxies {
  /** True when nothing is configured, so the header is never believed. */
  readonly empty: boolean;
  contains(ip: string): boolean;
}

interface Cidr {
  base: number;
  mask: number;
}

/**
 * Parse a comma-separated list of IPv4 addresses and CIDR ranges.
 *
 * IPv6 is matched literally rather than by prefix. A control plane behind a
 * proxy on an IPv6 network is unusual enough that supporting the exact address
 * is a better trade than shipping prefix arithmetic nothing here exercises;
 * anything unparseable is refused at startup rather than silently ignored,
 * because a trusted-proxy list that quietly matches nothing fails open.
 */
export function parseTrustedProxies(raw: string): TrustedProxies {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cidrs: Cidr[] = [];
  const literals = new Set<string>();

  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (cidr) {
      cidrs.push(cidr);
    } else if (entry.includes(":")) {
      literals.add(normaliseIpv6(entry));
    } else {
      throw new Error(
        `JP_TRUSTED_PROXIES contains "${entry}", which is not an IPv4 address, a CIDR range, or an IPv6 address.`,
      );
    }
  }

  return {
    empty: entries.length === 0,
    contains(ip: string): boolean {
      if (literals.has(normaliseIpv6(ip))) return true;
      const value = ipv4ToInt(stripIpv4Mapped(ip));
      if (value === null) return false;
      // `>>> 0` on the masked value, not just on the stored base. JavaScript's
      // bitwise operators work on *signed* 32-bit integers, so any address
      // above 127.255.255.255 comes out of `&` negative while the base was
      // stored unsigned — and 172.16.0.0/12 silently matched nothing.
      return cidrs.some((c) => ((value & c.mask) >>> 0) === c.base);
    },
  };
}

/**
 * The address to attribute a request to.
 *
 * When the peer is a trusted proxy, the forwarded chain is read right to left
 * and the first address that is not itself a trusted proxy wins. Taking the
 * leftmost entry instead — which is the obvious reading of the header — is the
 * classic mistake: with a proxy that *appends* rather than replaces, as nginx's
 * `$proxy_add_x_forwarded_for` does, the leftmost value is supplied by the
 * client and forgeable again.
 */
export function resolveClientIp(opts: {
  socketAddress: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  trusted: TrustedProxies;
}): string | null {
  const { socketAddress, forwardedFor, realIp, trusted } = opts;

  if (trusted.empty || !socketAddress || !trusted.contains(socketAddress)) {
    return socketAddress;
  }

  if (forwardedFor) {
    const chain = forwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (let i = chain.length - 1; i >= 0; i--) {
      const candidate = chain[i]!;
      if (!trusted.contains(candidate)) return candidate;
    }
    // Every hop is a trusted proxy, so the original client is the first entry.
    if (chain.length > 0) return chain[0]!;
  }

  if (realIp) return realIp.trim();
  return socketAddress;
}

function parseCidr(entry: string): Cidr | null {
  const [addr, bitsRaw] = entry.split("/");
  const base = ipv4ToInt(addr ?? "");
  if (base === null) return null;

  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;

  // `>>> 0` keeps the result unsigned; a /0 mask would otherwise be -1.
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** `::ffff:10.0.0.1` is an IPv4 address wearing a hat; Node hands these out. */
function stripIpv4Mapped(ip: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return match ? match[1]! : ip;
}

function normaliseIpv6(ip: string): string {
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
}
