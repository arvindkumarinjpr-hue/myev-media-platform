import { ALLOWED_MIME_BY_ASSET_TYPE, matchesExecutableSignature, resolveVerifiedMimeType, sniffMimeType } from "./mime-signatures";

function pad(buf: Buffer, length = 32): Buffer {
  if (buf.length >= length) return buf;
  return Buffer.concat([buf, Buffer.alloc(length - buf.length)]);
}

function isoBmff(brand: string): Buffer {
  const header = Buffer.alloc(12);
  header.write("ftyp", 4, "ascii");
  header.write(brand, 8, "ascii");
  return pad(header);
}

describe("sniffMimeType", () => {
  it("recognizes JPEG", () => {
    const buf = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "image/jpeg" });
  });

  it("recognizes PNG", () => {
    const buf = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "image/png" });
  });

  it("recognizes GIF", () => {
    const buf = pad(Buffer.from("GIF89a", "ascii"));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "image/gif" });
  });

  it("recognizes WEBP", () => {
    const buf = pad(Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "image/webp" });
  });

  it("recognizes WAV", () => {
    const buf = pad(Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii")]));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "audio/wav" });
  });

  it("recognizes OGG", () => {
    const buf = pad(Buffer.from("OggS", "ascii"));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "audio/ogg" });
  });

  it("recognizes ID3-tagged MP3", () => {
    const buf = pad(Buffer.from("ID3\x03\x00", "ascii"));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "audio/mpeg" });
  });

  it("recognizes a bare MP3 frame sync", () => {
    const buf = pad(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "audio/mpeg" });
  });

  it("recognizes PDF", () => {
    const buf = pad(Buffer.from("%PDF-1.4", "ascii"));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "application/pdf" });
  });

  it("recognizes WebM (EBML header)", () => {
    const buf = pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(sniffMimeType(buf)).toMatchObject({ matched: true, mimeType: "video/webm" });
  });

  it("recognizes QuickTime .mov via ftyp brand 'qt  '", () => {
    expect(sniffMimeType(isoBmff("qt  "))).toMatchObject({ matched: true, mimeType: "video/quicktime" });
  });

  it("flags the MP4-container family (ftyp isom) as ambiguous, not a direct match", () => {
    const result = sniffMimeType(isoBmff("isom"));
    expect(result.isAmbiguousMp4Family).toBe(true);
    expect(result.mimeType).toBeNull();
  });

  it("does not match unrecognized bytes", () => {
    const buf = Buffer.from("this is not a media file at all, just plain text padding", "ascii");
    expect(sniffMimeType(buf)).toMatchObject({ matched: false, mimeType: null });
  });
});

describe("matchesExecutableSignature", () => {
  it("catches a Windows PE header", () => {
    expect(matchesExecutableSignature(pad(Buffer.from([0x4d, 0x5a])))).toBe("windows_pe");
  });

  it("catches an ELF header", () => {
    expect(matchesExecutableSignature(pad(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))).toBe("elf");
  });

  it("catches a shebang", () => {
    expect(matchesExecutableSignature(pad(Buffer.from("#!/bin/sh\n", "ascii")))).toBe("shebang");
  });

  it("does not flag a real JPEG", () => {
    expect(matchesExecutableSignature(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toBeNull();
  });
});

describe("resolveVerifiedMimeType", () => {
  it("resolves an unambiguous match directly, if it's in the asset type's allowlist", () => {
    const sniff = sniffMimeType(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
    expect(resolveVerifiedMimeType(sniff, "IMAGE")).toBe("image/jpeg");
  });

  it("rejects a matched format that's outside the declared asset type's allowlist", () => {
    const sniff = sniffMimeType(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))); // image/jpeg
    expect(resolveVerifiedMimeType(sniff, "VIDEO")).toBeNull();
  });

  it("resolves the MP4-container ambiguity to video/mp4 when declared as VIDEO", () => {
    const sniff = sniffMimeType(isoBmff("isom"));
    expect(resolveVerifiedMimeType(sniff, "VIDEO")).toBe("video/mp4");
  });

  it("resolves the MP4-container ambiguity to audio/mp4 when declared as AUDIO", () => {
    const sniff = sniffMimeType(isoBmff("M4A "));
    expect(resolveVerifiedMimeType(sniff, "AUDIO")).toBe("audio/mp4");
  });

  it("rejects the MP4-container ambiguity when declared as an unrelated type", () => {
    const sniff = sniffMimeType(isoBmff("isom"));
    expect(resolveVerifiedMimeType(sniff, "IMAGE")).toBeNull();
    expect(resolveVerifiedMimeType(sniff, "DOCUMENT")).toBeNull();
  });

  it("rejects an unmatched/unknown format outright", () => {
    const sniff = sniffMimeType(Buffer.from("not a real media file", "ascii"));
    expect(resolveVerifiedMimeType(sniff, "IMAGE")).toBeNull();
  });
});

describe("ALLOWED_MIME_BY_ASSET_TYPE", () => {
  it("scopes DOCUMENT to PDF only in Module 1D", () => {
    expect(ALLOWED_MIME_BY_ASSET_TYPE.DOCUMENT).toEqual(["application/pdf"]);
  });
});
