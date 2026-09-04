import { createServer, type Server } from "node:https";
import type { DnsResolvers } from "../publishing-dns-safety";
import { WordPressChannelProvider } from "./wordpress-channel-provider";

/**
 * Module 9 Phase 9.4 Pre-Merge Security Correction — Part D proof: when
 * the connector connects to a DNS-pinned IP (via the custom `lookup`),
 * TLS SNI and certificate-hostname verification must stay pointed at the
 * ORIGINAL configured hostname, not silently weaken because a raw IP is
 * what the socket actually connects to. A real local HTTPS server with a
 * self-signed, CN=localhost certificate proves this directly — no public
 * internet dependency, and no `rejectUnauthorized: false` anywhere in
 * the implementation under test (grep-verified: wordpress-channel-provider.ts
 * never sets it).
 *
 * Test-only self-signed key/cert (openssl req -x509 -newkey rsa:2048
 * -days 7300 -nodes -subj "/CN=localhost"), valid for CN=localhost only
 * — never used for anything but this test.
 */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCrMoSESSih90YG
5IkGMzNrggyZ1yjDPcmg4BiLPHY25DCI8IeHz3Kn7AHxqgfEGoWlA/43X/EmL76y
Dr71kQHxQVkbjrD6MjowE9yVfFDz5ctnKnTLnDrSuEF+EP63y1Cs+zFU+yMNr1OW
8fQI/71FQqC2yknR12Tv+R+Mb8PadVTT6kxjevSTNmpb0IvDAGBOAq+Mo0qdP7OJ
hljg/qPPSOz/dYLeQnSe9TQiyCe9kSGQHZTWs+HfQ47JF7RzlCjCS7udW5rUFTC/
CgtHMvrjvjaKqxd/BBbz4MvyYlDjJfUY3hCdtx35SREy8pCl6cm/MgnG/8u9uE7W
EEGaZRsrAgMBAAECggEAS16DucuNkHTRBxLRAoJDFoccLhRr9Ty8Ck/ubkoxjyv5
9CfUuyVIyIXeOzsMjTjR8pql7lIWVCX78d8NEgaDkOegp8Gzx4qaVHVCDSu8Zgwa
dvJZlhRTT1bgOnSX92mSvH0gNFYWEh3IkrE1q0qP1LCnGaJISpJl9UI7sfO4iXGa
oYm801TzHcJXrpE3AnVb69MXcefwicz4updic7N3QldBlGB9DrilqEW39TSGTqQh
+RqMuUikJOFv93zdWHule6VpvPZxztWPfMLcnHRaJspWu+TAkkFfkywAinRkbhde
86cqx6/8I+FoHQppNzO5qfhUHl6Cbw4akB5hmths6QKBgQDgMMagR7l0+Hzwq1Zy
je8eR/0ge41nG1ikOYBtjxvp8z6+N/PHygidMS+bR9/qtLbgvHbDFOnEHFQZgu1c
UqqfLR44abnL2jNbTeMuDk6u+Yq7dqXPFrR4QoaRPxme58TFXcSV+30QrQQPriiA
g9hftXJLuOSuTjEastgxSWTB8wKBgQDDfOGhJCEWz7QwD1hNNpKPoIkV6Ot0l4i/
PX7ydQtk+vzX4zziLwLHTah+F1ttprG54Soh9FoUxM6Kq9pHQimu2ro8GxD7MNhp
mseM1kolPw0LQNmjZad082DJ7bK1HBc1tfqaQwQILfgEdwTFgPCnJIpL/FiWPveq
DdGJm91X6QKBgQC/FJOWtMs7CTfkIQTzaknuM0lp0CS7RrGMd34g4yLVif9mPWZI
WMhywiNjZCVTdGeSsM9Agqij/8kmXVNVpxfJx7jEOEilmPrAzWfeL0+dDw/Rq9Sy
5xU2ku0DCxcZO02ZMsyFUO5NskmN29CliLp5CLu8EoDGl9p+eQSPLZD1RQKBgHbh
BJznya+Dk8H+MuaRn0L0jyjhwf3fAOu7S+3Ju6om74ehyq6JhBkLYsF7FsBxtHaj
NOn9HKKwpCG0LENVOt/4Z3SRyRvYMmLWGy/MSL6pvxbu0usIsHLwZhWmFR0J/htN
lR4mTtdijQa6Eg7BQJeEIw3eYUjM9fNV/+y8+jexAoGBAJvLU7RrkDxmDOGT5Jfr
CgqVgmBDqt0jBggl3RE6VjgUDsX5bvE8F/+782xjqZiAZ686c93PQmRXuwJCLlfd
DnQGv0ToIkhXgChINb80sq3RqCrLUNESbWhwsVAHIUT7K7eq5jEE16v80UHlmlrO
RfFqUGGH5V/SFijL+Z3yOL3q
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUHF6Oj5G+PeZVW7xpcPzWxevqFMQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwNDE0MTMzM1oXDTQ2MDgz
MDE0MTMzM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqzKEhEkoofdGBuSJBjMza4IMmdcowz3JoOAYizx2NuQw
iPCHh89yp+wB8aoHxBqFpQP+N1/xJi++sg6+9ZEB8UFZG46w+jI6MBPclXxQ8+XL
Zyp0y5w60rhBfhD+t8tQrPsxVPsjDa9TlvH0CP+9RUKgtspJ0ddk7/kfjG/D2nVU
0+pMY3r0kzZqW9CLwwBgTgKvjKNKnT+ziYZY4P6jz0js/3WC3kJ0nvU0IsgnvZEh
kB2U1rPh30OOyRe0c5Qowku7nVua1BUwvwoLRzL64742iqsXfwQW8+DL8mJQ4yX1
GN4Qnbcd+UkRMvKQpenJvzIJxv/LvbhO1hBBmmUbKwIDAQABo1MwUTAdBgNVHQ4E
FgQUP2LySu/b4nlPfr6flg3Vo+jmS0IwHwYDVR0jBBgwFoAUP2LySu/b4nlPfr6f
lg3Vo+jmS0IwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAJYJK
2fQMVj5WsWchHaaocC/D1N3jKqXbvQlVBMHFuq342Gk6zKQLsc8VG+3IJyrFwM4W
/v7G9dXkxNBVTWDF1kpNd4j5PEvEpNlR7bGT1Lk5VMOfBH6X6GN/nlYgKcj7lS+B
ALFuW63D0P/Rle8QV02bxrP37lC5lrCRZIODRqQOiVx0N6tlJqXdZFw7e/c6gjfo
ErRW4ac3o7VMD7qeeXiWHp2GUPLAxawDUPThInf7D7AYykv7biUMU0KZ3g4mD+G2
I6cXRq0qbELGWRUTn6kuVehgXErEj01e6lKt+sHxKiIqD8XqAhxbudYmMmmXe6m3
xti51dU9eR9qRyIpgA==
-----END CERTIFICATE-----`;

async function startTlsFixtureServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    if (req.url?.startsWith("/wp-json/wp/v2/users/me")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1, name: "MYEV Bot" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS fixture server failed to bind.");
  return { port: address.port, close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))) };
}

describe("WordPressChannelProvider — TLS/SNI/certificate-hostname verification with DNS-pinned connections", () => {
  let fixture: { port: number; close: () => Promise<void> } | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("succeeds a real TLS handshake (SNI + certificate hostname verification) against the ORIGINAL hostname while the socket connects to a DNS-pinned IP resolved by an injected resolver — no rejectUnauthorized:false anywhere", async () => {
    fixture = await startTlsFixtureServer();
    const resolvers: DnsResolvers = {
      resolve4: (hostname) => (hostname === "localhost" ? Promise.resolve(["127.0.0.1"]) : Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))),
      resolve6: () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" })),
    };
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolvers, caCertificates: [TLS_CERT] });

    const result = await provider.validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: { siteUrl: `https://localhost:${fixture.port}`, username: "myev", applicationPassword: "abcd 1234 efgh 5678" },
      tokenExpiresAt: null,
    });

    expect(result).toEqual({ healthy: true });
  });

  it("FAILS the TLS handshake when the configured hostname does not match the certificate's CN, even though the injected resolver still points it at the exact same reachable server — proving certificate-hostname verification is genuinely active, not bypassed by the custom lookup", async () => {
    fixture = await startTlsFixtureServer();
    const resolvers: DnsResolvers = {
      resolve4: (hostname) => (hostname === "wrong-hostname.test.invalid" ? Promise.resolve(["127.0.0.1"]) : Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))),
      resolve6: () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" })),
    };
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolvers, caCertificates: [TLS_CERT] });

    const result = await provider.validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: { siteUrl: `https://wrong-hostname.test.invalid:${fixture.port}`, username: "myev", applicationPassword: "abcd 1234 efgh 5678" },
      tokenExpiresAt: null,
    });

    // The server is genuinely reachable at the DNS-pinned address (proven
    // by the previous test using the identical fixture with the correct
    // hostname) — this fails ONLY because the certificate's CN=localhost
    // does not match "wrong-hostname.test.invalid". A healthy result
    // here would mean certificate verification had been silently
    // disabled.
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  });
});
