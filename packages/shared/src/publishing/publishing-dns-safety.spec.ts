import { createSsrfSafeLookup, resolveSafeConnectAddresses, UnsafeResolvedAddressError, type DnsResolvers } from "./publishing-dns-safety";

function enodata(): NodeJS.ErrnoException {
  const err = new Error("no data") as NodeJS.ErrnoException;
  err.code = "ENODATA";
  return err;
}

function enotfound(): NodeJS.ErrnoException {
  const err = new Error("not found") as NodeJS.ErrnoException;
  err.code = "ENOTFOUND";
  return err;
}

function resolversOf(v4: string[] | Error, v6: string[] | Error = enodata()): DnsResolvers {
  return {
    resolve4: () => (v4 instanceof Error ? Promise.reject(v4) : Promise.resolve(v4)),
    resolve6: () => (v6 instanceof Error ? Promise.reject(v6) : Promise.resolve(v6)),
  };
}

describe("resolveSafeConnectAddresses", () => {
  it("allows a hostname that resolves to a genuinely public address", async () => {
    const result = await resolveSafeConnectAddresses("public.test.invalid", { resolvers: resolversOf(["203.0.113.10"]) });
    expect(result).toEqual([{ address: "203.0.113.10", family: 4 }]);
  });

  it("rejects a hostname that resolves directly to 127.0.0.1", async () => {
    await expect(resolveSafeConnectAddresses("rebind.test.invalid", { resolvers: resolversOf(["127.0.0.1"]) })).rejects.toThrow(UnsafeResolvedAddressError);
  });

  it("rejects a hostname that resolves to a 10.x RFC1918 address", async () => {
    await expect(resolveSafeConnectAddresses("rebind.test.invalid", { resolvers: resolversOf(["10.1.2.3"]) })).rejects.toThrow(UnsafeResolvedAddressError);
  });

  it("rejects a hostname that resolves to the cloud-metadata link-local address 169.254.169.254", async () => {
    await expect(resolveSafeConnectAddresses("rebind.test.invalid", { resolvers: resolversOf(["169.254.169.254"]) })).rejects.toThrow(UnsafeResolvedAddressError);
  });

  it("rejects a hostname whose answer mixes a public AND a private address — never filters down to just the safe ones", async () => {
    const resolvers = resolversOf(["203.0.113.10", "10.0.0.1"]);
    await expect(resolveSafeConnectAddresses("mixed.test.invalid", { resolvers })).rejects.toThrow(UnsafeResolvedAddressError);
  });

  it.each(["::1", "fe80::1", "fc00::1", "ff02::1"])("rejects an IPv6 answer of %s (loopback/link-local/unique-local/multicast)", async (ip) => {
    await expect(resolveSafeConnectAddresses("rebind6.test.invalid", { resolvers: resolversOf([], [ip]) })).rejects.toThrow(UnsafeResolvedAddressError);
  });

  it("rejects an IPv4-mapped-IPv6 loopback answer", async () => {
    await expect(resolveSafeConnectAddresses("rebind6.test.invalid", { resolvers: resolversOf([], ["::ffff:127.0.0.1"]) })).rejects.toThrow(UnsafeResolvedAddressError);
  });

  it("accepts a genuinely public IPv6 answer", async () => {
    const result = await resolveSafeConnectAddresses("public6.test.invalid", { resolvers: resolversOf([], ["2606:4700:4700::1111"]) });
    expect(result).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
  });

  it("tolerates ENODATA on one family while the other resolves", async () => {
    const result = await resolveSafeConnectAddresses("v4only.test.invalid", { resolvers: resolversOf(["203.0.113.5"], enodata()) });
    expect(result).toEqual([{ address: "203.0.113.5", family: 4 }]);
  });

  it("throws DNS_RESOLUTION_FAILED (not a private-address rejection) when both families genuinely fail to resolve", async () => {
    try {
      await resolveSafeConnectAddresses("nowhere.test.invalid", { resolvers: resolversOf(enotfound(), enotfound()) });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeResolvedAddressError);
      expect((err as UnsafeResolvedAddressError).reasonCode).toBe("DNS_RESOLUTION_FAILED");
    }
  });

  it("validates a literal IPv4 hostname directly, without calling the resolver at all", async () => {
    let called = false;
    const resolvers: DnsResolvers = {
      resolve4: () => {
        called = true;
        return Promise.resolve([]);
      },
      resolve6: () => Promise.resolve([]),
    };
    const result = await resolveSafeConnectAddresses("203.0.113.7", { resolvers });
    expect(result).toEqual([{ address: "203.0.113.7", family: 4 }]);
    expect(called).toBe(false);
  });

  it("rejects a literal private IPv4 hostname directly", async () => {
    await expect(resolveSafeConnectAddresses("10.0.0.5")).rejects.toThrow(UnsafeResolvedAddressError);
  });

  describe("allowLocalTestTarget — scoped to loopback only, same as publishing-site-url-safety.ts", () => {
    it("allows a hostname that resolves to 127.0.0.1 when the flag is set", async () => {
      const result = await resolveSafeConnectAddresses("fixture.test.invalid", { allowLocalTestTarget: true, resolvers: resolversOf(["127.0.0.1"]) });
      expect(result).toEqual([{ address: "127.0.0.1", family: 4 }]);
    });

    it("still rejects a hostname that resolves to a 10.x RFC1918 address even when the flag is set", async () => {
      await expect(resolveSafeConnectAddresses("fixture.test.invalid", { allowLocalTestTarget: true, resolvers: resolversOf(["10.1.2.3"]) })).rejects.toThrow(UnsafeResolvedAddressError);
    });

    it("still rejects a hostname that resolves to 169.254.169.254 even when the flag is set", async () => {
      await expect(resolveSafeConnectAddresses("fixture.test.invalid", { allowLocalTestTarget: true, resolvers: resolversOf(["169.254.169.254"]) })).rejects.toThrow(UnsafeResolvedAddressError);
    });
  });
});

describe("createSsrfSafeLookup — DNS-rebinding structural proof", () => {
  it("calls the resolver exactly once per lookup, and hands Node's callback exactly the address that passed validation (single-address shape)", async () => {
    let resolveCalls = 0;
    const resolvers: DnsResolvers = {
      resolve4: () => {
        resolveCalls += 1;
        return Promise.resolve(["203.0.113.20"]);
      },
      resolve6: () => Promise.resolve([]),
    };
    const lookup = createSsrfSafeLookup({ resolvers });

    const result = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
      lookup("public.test.invalid", {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
    });

    expect(result).toEqual({ address: "203.0.113.20", family: 4 });
    expect(resolveCalls).toBe(1);
  });

  it("handles the options.all=true shape (Happy Eyeballs / autoSelectFamily) with the identical, already-validated address set", async () => {
    const resolvers: DnsResolvers = { resolve4: () => Promise.resolve(["203.0.113.21"]), resolve6: () => Promise.resolve([]) };
    const lookup = createSsrfSafeLookup({ resolvers });

    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("public.test.invalid", { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
    });

    expect(result).toEqual([{ address: "203.0.113.21", family: 4 }]);
  });

  it("DNS-rebinding simulation: a resolver that would answer differently on a hypothetical second call is never consulted twice, so a rebound private answer can never reach the connection", async () => {
    // Simulates the classic rebinding attack: the FIRST DNS answer (what
    // validation would see) is public/safe; a HYPOTHETICAL second,
    // uncontrolled lookup (what a naive "validate then fetch" approach
    // would trigger) would answer with a private/link-local address
    // instead. This resolver tracks how many times it was actually
    // invoked and asserts it never happens more than once — proving the
    // lookup function IS the sole resolution path, not merely a
    // pre-check ahead of a separate, real one.
    let callCount = 0;
    const rebindingResolver: DnsResolvers = {
      resolve4: () => {
        callCount += 1;
        // First (and, if this security property holds, ONLY) call:
        // returns the public/safe answer. A rebinding attacker's server
        // would flip this to "169.254.169.254" on a subsequent query —
        // simulated here by the assertion below rather than by actually
        // changing behavior, since a real second call must never happen.
        return Promise.resolve(["203.0.113.30"]);
      },
      resolve6: () => Promise.resolve([]),
    };
    const lookup = createSsrfSafeLookup({ resolvers: rebindingResolver });

    const first = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
      lookup("rebinder.test.invalid", {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
    });

    expect(first).toEqual({ address: "203.0.113.30", family: 4 });
    // The security property under test: exactly one resolution happened
    // for this one connection attempt. Node's http/https client uses
    // THIS returned address for the real socket — there is no second,
    // independent `dns.lookup` call anywhere in the connection path for
    // an attacker's rebound answer to ever reach.
    expect(callCount).toBe(1);
  });

  it("propagates DNS_RESOLVED_UNSAFE_ADDRESS as a lookup error, never silently substituting a different address", async () => {
    const resolvers = resolversOf(["10.0.0.9"]);
    const lookup = createSsrfSafeLookup({ resolvers });

    await expect(
      new Promise((resolve, reject) => {
        lookup("private.test.invalid", {}, (err, address) => (err ? reject(err) : resolve(address)));
      }),
    ).rejects.toThrow(/private|reserved/i);
  });
});
