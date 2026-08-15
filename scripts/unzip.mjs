// unzip.mjs — read entries out of a ZIP with nothing but zlib.
//
// The SEC ships its quarterly insider datasets as ZIPs and this repo has no
// archive dependency (and should not grow one for a single caller). The format
// needed here is the boring 1989 half of it: a central directory at the end, one
// local header per file, and either stored or deflated bytes. No ZIP64, no
// encryption, no spanning — all three are asserted rather than assumed, so a
// file that needs them fails loudly instead of producing silent garbage.

import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/**
 * @param {Buffer} buf  the whole archive
 * @returns {Map<string, Buffer>} filename → contents
 */
export function unzip(buf) {
  // The end-of-central-directory record sits in the last 64 KB (its comment can
  // push it off the very end), so scan backwards for the signature.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error("ZIP64 archives are not supported here");

  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CEN) throw new Error(`corrupt central directory at entry ${n}`);
    const method = buf.readUInt16LE(off + 10);
    const flags = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`${name}: encrypted entries are not supported`);
    if (name.endsWith("/")) continue;                       // directory entry

    if (buf.readUInt32LE(localOff) !== LOC) throw new Error(`${name}: bad local header`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: unsupported compression method ${method}`);
  }
  return out;
}
