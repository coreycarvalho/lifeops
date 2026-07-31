/**
 * Is this endpoint on the operator's own network?
 *
 * Invariant 4 is the one guarantee LifeOps makes about the data it holds: nothing captured
 * leaves the operator's network, and through M6 that means no hosted-provider calls at all.
 * Checking that `LLM_BASE_URL` is a valid http(s) URL does not enforce that — a stray
 * `https://api.openai.com/v1` is a perfectly valid URL, and every dump would go there.
 *
 * So the host is checked against what the operator can plausibly own: loopback, the private
 * and link-local ranges, and names that cannot resolve outside a local resolver. This is a
 * syntactic check, not a routing proof — a public DNS name pointing at a private address is
 * rejected, which is the safe direction to be wrong in.
 *
 * There is deliberately **no override flag**. Reaching a hosted provider is meant to be a
 * code change with an entry in docs/DECISIONS.md (see "No `LLM_PROVIDER` switch"), not
 * something a typo in an env file can do.
 */

/** Names that only a local resolver can answer for. */
const LOCAL_SUFFIXES = [
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  // Tailscale MagicDNS. Public registry, but a `*.ts.net` name resolves only to the
  // operator's own tailnet — 100.64.0.0/10 or fd7a::/48 — and never to the open internet.
  ".ts.net",
];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // Reject "010.0.0.1" and friends rather than guessing at the intent.
  if (parts.some((p) => p !== String(Number(p)))) return false;

  const [a, b] = octets;
  return (
    a === 127 || // loopback
    a === 10 || // RFC1918
    a === 0 || // "this host"
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) // CGNAT — what Tailscale and friends hand out
  );
}

function isPrivateIPv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (address === "::1" || address === "::") return true;

  const first = address.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const hextet = Number.parseInt(first, 16);

  // fc00::/7 unique-local (fc00–fdff) and fe80::/10 link-local (fe80–febf).
  return (
    (hextet >= 0xfc00 && hextet <= 0xfdff) ||
    (hextet >= 0xfe80 && hextet <= 0xfebf)
  );
}

export function isOperatorNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "") return false;
  if (host === "localhost") return true;
  if (host.includes(":") || host.startsWith("[")) return isPrivateIPv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);

  // A bare name with no dots can only be answered by the local resolver or /etc/hosts.
  if (!host.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
