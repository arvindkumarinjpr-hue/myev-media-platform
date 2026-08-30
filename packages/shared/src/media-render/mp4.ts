/**
 * Module 7 Phase 7.5 — dependency-free ISO base media file format
 * (MP4 / QuickTime) inspection + a deterministic MP4 generator.
 *
 * `parseMp4` is the "ffprobe or equivalent deterministic inspection"
 * (checkpoint §13/§19/§20): it walks the box tree and reads the
 * authoritative geometry (`tkhd` width/height) and duration (`mvhd`
 * timescale/duration). It does NOT trust any value the renderer merely
 * *requested* — it reads what the container actually declares.
 *
 * `buildDeterministicMp4` produces a byte-for-byte reproducible,
 * structurally valid MP4 whose `moov` truthfully encodes the requested
 * width/height/duration/fps. It is the backing store for the
 * deterministic test render engine (checkpoint §32) — a real file that
 * `parseMp4` (and any generic box walker) reads correctly, without
 * FFmpeg or a browser.
 */

export interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly size: number;
  readonly headerSize: number;
}

export interface Mp4Info {
  readonly ok: boolean;
  readonly errors: string[];
  /** Major brand from `ftyp`. */
  readonly majorBrand: string | null;
  readonly hasMoov: boolean;
  /** Video track pixel dimensions from `tkhd` (integer part of the 16.16 fixed value). */
  readonly width: number | null;
  readonly height: number | null;
  /** Movie duration in milliseconds from `mvhd` (duration / timescale). */
  readonly durationMs: number | null;
  readonly byteLength: number;
  /** True when a soundtrack `trak` (handler `soun`) is present. */
  readonly hasAudioTrack: boolean;
}

function readBoxes(buf: Buffer, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      // 64-bit largesize — only the low 32 bits are meaningful for our files.
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  return boxes;
}

function findBox(buf: Buffer, boxes: Mp4Box[], path: string[]): { box: Mp4Box; payloadStart: number } | null {
  let current = boxes;
  let found: Mp4Box | null = null;
  for (let i = 0; i < path.length; i++) {
    found = current.find((b) => b.type === path[i]) ?? null;
    if (!found) return null;
    if (i < path.length - 1) {
      current = readBoxes(buf, found.start + found.headerSize, found.start + found.size);
    }
  }
  return found ? { box: found, payloadStart: found.start + found.headerSize } : null;
}

export function parseMp4(buf: Buffer): Mp4Info {
  const errors: string[] = [];
  const base: Omit<Mp4Info, "ok" | "errors"> = {
    majorBrand: null,
    hasMoov: false,
    width: null,
    height: null,
    durationMs: null,
    byteLength: buf.length,
    hasAudioTrack: false,
  };
  if (buf.length < 16) {
    return { ...base, ok: false, errors: ["file is too small to be an MP4"] };
  }

  const top = readBoxes(buf, 0, buf.length);
  if (top.length === 0) return { ...base, ok: false, errors: ["no top-level boxes found"] };

  const ftyp = top.find((b) => b.type === "ftyp");
  const majorBrand = ftyp && ftyp.size >= 12 ? buf.toString("latin1", ftyp.start + 8, ftyp.start + 12) : null;
  if (!ftyp) errors.push("missing ftyp box");

  const moov = top.find((b) => b.type === "moov");
  if (!moov) {
    return { ...base, majorBrand, ok: false, errors: [...errors, "missing moov box"] };
  }
  const moovBoxes = readBoxes(buf, moov.start + moov.headerSize, moov.start + moov.size);

  let durationMs: number | null = null;
  const mvhd = moovBoxes.find((b) => b.type === "mvhd");
  if (mvhd) {
    const p = mvhd.start + mvhd.headerSize;
    const version = buf.readUInt8(p);
    if (version === 0 && mvhd.size >= mvhd.headerSize + 20) {
      const timescale = buf.readUInt32BE(p + 12);
      const duration = buf.readUInt32BE(p + 16);
      if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
    } else if (version === 1 && mvhd.size >= mvhd.headerSize + 32) {
      const timescale = buf.readUInt32BE(p + 20);
      const duration = Number(buf.readBigUInt64BE(p + 24));
      if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
    }
  } else {
    errors.push("missing mvhd box");
  }

  let width: number | null = null;
  let height: number | null = null;
  let hasAudioTrack = false;
  for (const trak of moovBoxes.filter((b) => b.type === "trak")) {
    const trakBoxes = readBoxes(buf, trak.start + trak.headerSize, trak.start + trak.size);
    const hdlr = findBox(buf, trakBoxes, ["mdia", "hdlr"]);
    const handler = hdlr ? buf.toString("latin1", hdlr.payloadStart + 8, hdlr.payloadStart + 12) : "";
    if (handler === "soun") hasAudioTrack = true;
    const tkhd = trakBoxes.find((b) => b.type === "tkhd");
    if (tkhd && handler !== "soun") {
      const p = tkhd.start + tkhd.headerSize;
      const version = buf.readUInt8(p);
      const geomOffset = version === 1 ? 96 : 84; // width is 8 bytes before end of the fixed region
      if (tkhd.size >= tkhd.headerSize + geomOffset) {
        const w = buf.readUInt32BE(p + geomOffset - 8) >>> 16;
        const h = buf.readUInt32BE(p + geomOffset - 4) >>> 16;
        if (w > 0 && h > 0) {
          width = w;
          height = h;
        }
      }
    }
  }
  if (width === null || height === null) errors.push("no video track geometry (tkhd) found");
  if (durationMs === null) errors.push("no movie duration (mvhd) found");

  return {
    ...base,
    majorBrand,
    hasMoov: true,
    width,
    height,
    durationMs,
    hasAudioTrack,
    ok: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------
// Deterministic generator
// ---------------------------------------------------------------------

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt8(version, 0);
  vf.writeUIntBE(flags, 1, 3);
  return box(type, Buffer.concat([vf, payload]));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
}
function fixed1616(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE((n << 16) >>> 0, 0);
  return b;
}

const IDENTITY_MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export interface BuildMp4Options {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationMs: number;
  readonly fps: number;
  /** Add a silent soundtrack `trak` so `hasAudioTrack` is true. */
  readonly withAudioTrack?: boolean;
}

/**
 * Builds a minimal, structurally valid, fully reproducible MP4. The
 * `moov` truthfully encodes the requested geometry and duration; frame
 * count is `round(durationMs/1000 * fps)`. There is no real coded media
 * payload (the deterministic engine does not encode pixels) — the file
 * exists to exercise the render-job → MediaAsset → inspection → QA chain
 * with a genuine artifact, not to be played.
 */
export function buildDeterministicMp4(options: BuildMp4Options): Buffer {
  const timescale = 1000;
  const duration = Math.max(1, Math.round(options.durationMs));
  const frameCount = Math.max(1, Math.round((options.durationMs / 1000) * options.fps));
  const sampleDelta = Math.max(1, Math.round(timescale / options.fps));

  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), u32(0x200), Buffer.from("isomiso2avc1mp41", "latin1")]));

  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    Buffer.concat([
      u32(0), // creation
      u32(0), // modification
      u32(timescale),
      u32(duration),
      u32(0x00010000), // rate 1.0
      u16(0x0100), // volume 1.0
      u16(0), // reserved
      u32(0),
      u32(0), // reserved
      IDENTITY_MATRIX,
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(0), // pre_defined
      u32(2), // next track id
    ]),
  );

  const videoTkhd = fullBox(
    "tkhd",
    0,
    0x000007,
    Buffer.concat([
      u32(0),
      u32(0),
      u32(1), // track id
      u32(0),
      u32(duration),
      u32(0),
      u32(0), // reserved
      u16(0),
      u16(0), // layer, alt group
      u16(0),
      u16(0), // volume, reserved
      IDENTITY_MATRIX,
      fixed1616(options.widthPx),
      fixed1616(options.heightPx),
    ]),
  );

  const mdhd = fullBox("mdhd", 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)]));
  const vHdlr = fullBox("hdlr", 0, 0, Buffer.concat([u32(0), Buffer.from("vide", "latin1"), u32(0), u32(0), u32(0), Buffer.from("MYEV Video\0", "latin1")]));
  const vmhd = fullBox("vmhd", 0, 1, Buffer.concat([u16(0), u16(0), u16(0), u16(0)]));
  const dref = fullBox("dref", 0, 0, Buffer.concat([u32(1), fullBox("url ", 0, 1, Buffer.alloc(0))]));
  const dinf = box("dinf", dref);

  const stsd = fullBox("stsd", 0, 0, Buffer.concat([u32(1), box("avc1", Buffer.concat([Buffer.alloc(24), u16(options.widthPx), u16(options.heightPx), u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff)]))]));
  const stts = fullBox("stts", 0, 0, Buffer.concat([u32(1), u32(frameCount), u32(sampleDelta)]));
  const stsc = fullBox("stsc", 0, 0, u32(0));
  const stsz = fullBox("stsz", 0, 0, Buffer.concat([u32(0), u32(frameCount)]));
  const stco = fullBox("stco", 0, 0, u32(0));
  const stbl = box("stbl", Buffer.concat([stsd, stts, stsc, stsz, stco]));
  const minf = box("minf", Buffer.concat([vmhd, dinf, stbl]));
  const mdia = box("mdia", Buffer.concat([mdhd, vHdlr, minf]));
  const videoTrak = box("trak", Buffer.concat([videoTkhd, mdia]));

  const traks = [videoTrak];
  if (options.withAudioTrack) {
    const aTkhd = fullBox(
      "tkhd",
      0,
      0x000007,
      Buffer.concat([u32(0), u32(0), u32(2), u32(0), u32(duration), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), IDENTITY_MATRIX, fixed1616(0), fixed1616(0)]),
    );
    const aMdhd = fullBox("mdhd", 0, 0, Buffer.concat([u32(0), u32(0), u32(48000), u32(Math.round((duration / 1000) * 48000)), u16(0x55c4), u16(0)]));
    const aHdlr = fullBox("hdlr", 0, 0, Buffer.concat([u32(0), Buffer.from("soun", "latin1"), u32(0), u32(0), u32(0), Buffer.from("MYEV Audio\0", "latin1")]));
    const smhd = fullBox("smhd", 0, 0, Buffer.concat([u16(0), u16(0)]));
    const aStbl = box(
      "stbl",
      Buffer.concat([
        fullBox("stsd", 0, 0, Buffer.concat([u32(1), box("mp4a", Buffer.concat([Buffer.alloc(16), u16(2), u16(16), u32(0), u32(48000 << 16)]))])),
        fullBox("stts", 0, 0, u32(0)),
        fullBox("stsc", 0, 0, u32(0)),
        fullBox("stsz", 0, 0, Buffer.concat([u32(0), u32(0)])),
        fullBox("stco", 0, 0, u32(0)),
      ]),
    );
    const aMinf = box("minf", Buffer.concat([smhd, dinf, aStbl]));
    traks.push(box("trak", Buffer.concat([aTkhd, box("mdia", Buffer.concat([aMdhd, aHdlr, aMinf]))])));
  }

  const moov = box("moov", Buffer.concat([mvhd, ...traks]));
  const mdat = box("mdat", Buffer.from("MYEV-DETERMINISTIC-RENDER", "latin1"));
  return Buffer.concat([ftyp, moov, mdat]);
}
