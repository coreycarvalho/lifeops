import { describe, expect, it } from "vitest";
import { isOperatorNetworkHost } from "./endpoint";

/**
 * Invariant 4 is the guarantee the whole project rests on. A valid URL is not a local URL,
 * and the difference is a config typo away.
 */

describe("hosts the operator can plausibly own", () => {
  it("accepts loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isOperatorNetworkHost(host)).toBe(true);
    }
  });

  it("accepts the private IPv4 ranges", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.50",
      "169.254.1.1", // link-local
    ]) {
      expect(isOperatorNetworkHost(host)).toBe(true);
    }
  });

  it("accepts the CGNAT range, which is what a VPN overlay hands out", () => {
    // Tailscale and friends. A GPU box reached over the tailnet is the setup SPEC assumes.
    for (const host of ["100.64.0.1", "100.100.100.100", "100.127.255.254"]) {
      expect(isOperatorNetworkHost(host)).toBe(true);
    }
  });

  it("accepts private IPv6", () => {
    for (const host of ["fd00::1", "[fd7a:115c::1]", "fc00::1", "fe80::1"]) {
      expect(isOperatorNetworkHost(host)).toBe(true);
    }
  });

  it("accepts names only a local resolver can answer", () => {
    for (const host of [
      "ollama", // bare hostname — /etc/hosts or a local resolver
      "gpu-box.local",
      "ollama.internal",
      "nas.lan",
      "server.home.arpa",
      "gpu.tail1a2b.ts.net", // MagicDNS, which only ever resolves into the tailnet
    ]) {
      expect(isOperatorNetworkHost(host)).toBe(true);
    }
  });
});

describe("hosts that would send captures off the network", () => {
  it("rejects the hosted providers by name", () => {
    // The whole point. Setting this by accident must not silently ship every dump offsite.
    for (const host of [
      "api.openai.com",
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
      "openrouter.ai",
      "ai-gateway.vercel.sh",
    ]) {
      expect(isOperatorNetworkHost(host)).toBe(false);
    }
  });

  it("rejects public IPv4 addresses", () => {
    for (const host of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.1.1", "100.128.0.1"]) {
      expect(isOperatorNetworkHost(host)).toBe(false);
    }
  });

  it("rejects public IPv6 addresses", () => {
    for (const host of ["2001:4860:4860::8888", "[2606:4700::1111]"]) {
      expect(isOperatorNetworkHost(host)).toBe(false);
    }
  });

  it("is not fooled by a local-looking name on a public domain", () => {
    for (const host of [
      "localhost.example.com",
      "127.0.0.1.nip.io",
      "ts.net.example.com",
      "internal.example.com",
    ]) {
      expect(isOperatorNetworkHost(host)).toBe(false);
    }
  });

  it("rejects a zero-padded address rather than guessing what it meant", () => {
    // "010.0.0.1" is octal in some resolvers and decimal in others. Not worth the ambiguity.
    expect(isOperatorNetworkHost("010.0.0.1")).toBe(false);
  });

  it("rejects an empty host", () => {
    expect(isOperatorNetworkHost("")).toBe(false);
  });
});
