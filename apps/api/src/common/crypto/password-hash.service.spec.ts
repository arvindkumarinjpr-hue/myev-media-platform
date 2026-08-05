import { PasswordHashService } from "./password-hash.service";

describe("PasswordHashService", () => {
  const service = new PasswordHashService();

  it("hashes a password and verifies the correct plaintext against it", async () => {
    const hash = await service.hash("a-real-password-123");
    await expect(service.verify(hash, "a-real-password-123")).resolves.toBe(true);
  });

  it("rejects the wrong plaintext against a valid hash", async () => {
    const hash = await service.hash("a-real-password-123");
    await expect(service.verify(hash, "a-different-password-456")).resolves.toBe(false);
  });

  it("produces a different hash for the same password on each call (random salt)", async () => {
    const [hashA, hashB] = await Promise.all([service.hash("same-password-123"), service.hash("same-password-123")]);
    expect(hashA).not.toEqual(hashB);
  });

  it("returns false (never throws) when verifying against a malformed hash", async () => {
    await expect(service.verify("not-a-real-argon2-hash", "anything")).resolves.toBe(false);
  });

  it("produces an argon2id hash tagged with the OWASP-baseline parameters", async () => {
    const hash = await service.hash("a-real-password-123");
    expect(hash).toMatch(/^\$argon2id\$v=\d+\$m=19456,t=2,p=1\$/);
  });
});
