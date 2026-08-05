import { TokenService } from "./token.service";

describe("TokenService", () => {
  const service = new TokenService();

  it("generates url-safe opaque tokens with no repeats across many calls", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => service.generateOpaqueToken()));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("hashes deterministically — same plaintext always produces the same hash", () => {
    const plaintext = "some-opaque-token-value";
    expect(service.hashToken(plaintext)).toEqual(service.hashToken(plaintext));
  });

  it("produces different hashes for different plaintexts", () => {
    expect(service.hashToken("token-a")).not.toEqual(service.hashToken("token-b"));
  });

  it("never returns the plaintext itself as the hash", () => {
    const plaintext = service.generateOpaqueToken();
    expect(service.hashToken(plaintext)).not.toEqual(plaintext);
  });
});
