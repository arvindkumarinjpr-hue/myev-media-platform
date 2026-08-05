import { computeSessionFingerprint, parseDeviceMetadata } from "./device.util";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
const MOBILE_SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const CURL_UA = "curl/8.7.1";

describe("parseDeviceMetadata", () => {
  it("returns all-null metadata when no user agent is present", () => {
    expect(parseDeviceMetadata(undefined)).toEqual({
      deviceName: null,
      browser: null,
      operatingSystem: null,
      platform: null,
    });
  });

  it("identifies Chrome on Windows as a desktop", () => {
    const result = parseDeviceMetadata(CHROME_WINDOWS);
    expect(result.browser).toMatch(/^Chrome/);
    expect(result.operatingSystem).toMatch(/^Windows/);
    expect(result.platform).toBe("desktop");
  });

  it("identifies Safari on macOS as a desktop", () => {
    const result = parseDeviceMetadata(SAFARI_MAC);
    expect(result.browser).toMatch(/^Safari/);
    expect(result.operatingSystem).toMatch(/^macOS/);
    expect(result.platform).toBe("desktop");
  });

  it("identifies Firefox on Linux as a desktop", () => {
    const result = parseDeviceMetadata(FIREFOX_LINUX);
    expect(result.browser).toMatch(/^Firefox/);
    expect(result.operatingSystem).toBe("Linux");
    expect(result.platform).toBe("desktop");
  });

  it("identifies mobile Safari on iOS as mobile", () => {
    const result = parseDeviceMetadata(MOBILE_SAFARI_IOS);
    expect(result.operatingSystem).toMatch(/^iOS/);
    expect(result.platform).toBe("mobile");
  });

  it("identifies Chrome on Android as mobile", () => {
    const result = parseDeviceMetadata(CHROME_ANDROID);
    expect(result.browser).toMatch(/^Chrome/);
    expect(result.operatingSystem).toMatch(/^Android/);
    expect(result.platform).toBe("mobile");
  });

  it("falls back to null browser/OS for an unrecognized user agent, still classified as desktop", () => {
    const result = parseDeviceMetadata(CURL_UA);
    expect(result.browser).toBeNull();
    expect(result.operatingSystem).toBeNull();
    expect(result.platform).toBe("desktop");
  });

  it("never populates deviceName — reserved for a future client-supplied value", () => {
    expect(parseDeviceMetadata(CHROME_WINDOWS).deviceName).toBeNull();
  });
});

describe("computeSessionFingerprint", () => {
  it("is deterministic for the same ip + user agent", () => {
    const a = computeSessionFingerprint("1.2.3.4", CHROME_WINDOWS);
    const b = computeSessionFingerprint("1.2.3.4", CHROME_WINDOWS);
    expect(a).toEqual(b);
  });

  it("differs when the IP address changes", () => {
    const a = computeSessionFingerprint("1.2.3.4", CHROME_WINDOWS);
    const b = computeSessionFingerprint("5.6.7.8", CHROME_WINDOWS);
    expect(a).not.toEqual(b);
  });

  it("differs when the user agent changes", () => {
    const a = computeSessionFingerprint("1.2.3.4", CHROME_WINDOWS);
    const b = computeSessionFingerprint("1.2.3.4", FIREFOX_LINUX);
    expect(a).not.toEqual(b);
  });

  it("produces a 64-character hex SHA-256 digest even with missing inputs", () => {
    const fingerprint = computeSessionFingerprint(undefined, undefined);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
