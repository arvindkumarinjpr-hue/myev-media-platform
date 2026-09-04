import { assertSafePublishingSiteUrl, isSafePublishingRedirectTarget, UnsafePublishingSiteUrlError } from "./publishing-site-url-safety";

describe("assertSafePublishingSiteUrl", () => {
  it("accepts a normal HTTPS site URL and strips a trailing slash", () => {
    expect(assertSafePublishingSiteUrl("https://example.com/")).toBe("https://example.com");
    expect(assertSafePublishingSiteUrl("https://example.com")).toBe("https://example.com");
    expect(assertSafePublishingSiteUrl("https://example.com/blog/")).toBe("https://example.com/blog");
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSafePublishingSiteUrl("not a url")).toThrow(UnsafePublishingSiteUrlError);
  });

  it("rejects a non-HTTPS scheme by default", () => {
    expect(() => assertSafePublishingSiteUrl("http://example.com")).toThrow(UnsafePublishingSiteUrlError);
    expect(() => assertSafePublishingSiteUrl("ftp://example.com")).toThrow(UnsafePublishingSiteUrlError);
  });

  it("allows http:// only when allowLocalTestTarget is explicitly set (test-only escape hatch)", () => {
    expect(() => assertSafePublishingSiteUrl("http://example.com", { allowLocalTestTarget: true })).not.toThrow();
    expect(assertSafePublishingSiteUrl("http://example.com", { allowLocalTestTarget: true })).toBe("http://example.com");
  });

  it("rejects a URL with embedded credentials", () => {
    expect(() => assertSafePublishingSiteUrl("https://user:pass@example.com")).toThrow(UnsafePublishingSiteUrlError);
  });

  it.each(["localhost", "sub.local", "host.internal", "box.localdomain"])("rejects the blocked hostname %s", (host) => {
    expect(() => assertSafePublishingSiteUrl(`https://${host}`)).toThrow(UnsafePublishingSiteUrlError);
  });

  it("allowLocalTestTarget relaxes both the scheme AND the private-host checks together — never independently", () => {
    expect(() => assertSafePublishingSiteUrl("http://127.0.0.1:4000", { allowLocalTestTarget: true })).not.toThrow();
    expect(() => assertSafePublishingSiteUrl("http://localhost:4000", { allowLocalTestTarget: true })).not.toThrow();
  });

  it.each(["10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "0.0.0.0"])(
    "still rejects the non-loopback private/reserved address %s even with allowLocalTestTarget on — the bypass is scoped to loopback only",
    (ip) => {
      expect(() => assertSafePublishingSiteUrl(`http://${ip}`, { allowLocalTestTarget: true })).toThrow(UnsafePublishingSiteUrlError);
    },
  );

  it("still rejects a non-loopback private IPv6 address even with allowLocalTestTarget on", () => {
    expect(() => assertSafePublishingSiteUrl("http://[fc00::1]", { allowLocalTestTarget: true })).toThrow(UnsafePublishingSiteUrlError);
  });

  it.each(["127.0.0.1", "127.5.5.5", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "169.254.169.254", "0.0.0.0"])(
    "rejects the private/reserved IPv4 address %s",
    (ip) => {
      expect(() => assertSafePublishingSiteUrl(`https://${ip}`)).toThrow(UnsafePublishingSiteUrlError);
    },
  );

  it.each(["8.8.8.8", "1.1.1.1", "203.0.113.10", "172.32.0.1", "172.15.255.255"])("accepts a genuinely public IPv4 address %s (boundary-adjacent RFC1918 cases included)", (ip) => {
    expect(() => assertSafePublishingSiteUrl(`https://${ip}`)).not.toThrow();
  });

  it.each(["[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd12:3456:789a::1]"])("rejects the private/reserved IPv6 address %s", (ip) => {
    expect(() => assertSafePublishingSiteUrl(`https://${ip}`)).toThrow(UnsafePublishingSiteUrlError);
  });

  it("rejects an IPv4-mapped IPv6 loopback address", () => {
    expect(() => assertSafePublishingSiteUrl("https://[::ffff:127.0.0.1]")).toThrow(UnsafePublishingSiteUrlError);
  });

  it("accepts a genuinely public IPv6 address", () => {
    expect(() => assertSafePublishingSiteUrl("https://[2606:4700:4700::1111]")).not.toThrow();
  });
});

describe("isSafePublishingRedirectTarget", () => {
  it("returns true for a safe target, false for an unsafe one — never throws either way", () => {
    expect(isSafePublishingRedirectTarget("https://example.com")).toBe(true);
    expect(isSafePublishingRedirectTarget("https://127.0.0.1")).toBe(false);
    expect(isSafePublishingRedirectTarget("not a url")).toBe(false);
  });
});
