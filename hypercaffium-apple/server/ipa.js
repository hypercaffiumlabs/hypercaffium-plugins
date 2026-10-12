// Reads the version and build number out of an .ipa (a zip archive) without any dependencies:
// find Payload/<App>.app/Info.plist in the zip, inflate it, and read two keys from the plist
// (XML or binary). Used so an upload preview shows what is really inside the file.
import zlib from 'node:zlib';

function findEntry(buf, test) {
  // End of central directory record: signature 0x06054b50, within the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (test(name)) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip compression ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Minimal binary plist reader: enough for a top-level dictionary of strings.
function readBinaryPlist(b) {
  const trailer = b.subarray(b.length - 32);
  const offSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));
  const readInt = (pos, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + b[pos + i];
    return v;
  };
  const offsetOf = (ref) => readInt(tableOffset + ref * offSize, offSize);
  const lengthAt = (pos, info) => {
    if (info !== 0xf) return { len: info, start: pos + 1 };
    const intMarker = b[pos + 1];
    const size = 1 << (intMarker & 0xf);
    return { len: readInt(pos + 2, size), start: pos + 2 + size };
  };
  const readObject = (ref) => {
    const pos = offsetOf(ref);
    const marker = b[pos];
    const type = marker >> 4;
    const info = marker & 0xf;
    if (type === 0x5) {
      const { len, start } = lengthAt(pos, info);
      return b.subarray(start, start + len).toString('latin1');
    }
    if (type === 0x6) {
      const { len, start } = lengthAt(pos, info);
      return b.subarray(start, start + len * 2).swap16().toString('utf16le');
    }
    if (type === 0xd) {
      const { len, start } = lengthAt(pos, info);
      const out = {};
      for (let i = 0; i < len; i++) {
        const k = readObject(readInt(start + i * refSize, refSize));
        const vRef = readInt(start + (len + i) * refSize, refSize);
        const vMarker = b[offsetOf(vRef)] >> 4;
        if (typeof k === 'string' && (vMarker === 0x5 || vMarker === 0x6)) out[k] = readObject(vRef);
      }
      return out;
    }
    return null;
  };
  if (top >= numObjects) throw new Error('bad binary plist');
  return readObject(top) || {};
}

function readXmlPlist(text) {
  const get = (key) => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return m ? m[1] : undefined;
  };
  return { CFBundleShortVersionString: get('CFBundleShortVersionString'), CFBundleVersion: get('CFBundleVersion'), CFBundleIdentifier: get('CFBundleIdentifier') };
}

// Returns { versionString, buildNumber, bundleId } or throws a plain-English error.
export function readIpaInfo(buf) {
  let plist;
  try {
    plist = findEntry(buf, (n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n));
  } catch (err) {
    throw new Error(`This file is not a valid .ipa (${err.message}).`);
  }
  if (!plist) throw new Error('No Payload/<App>.app/Info.plist inside this .ipa.');
  const dict = plist.subarray(0, 8).toString('latin1') === 'bplist00' ? readBinaryPlist(plist) : readXmlPlist(plist.toString('utf8'));
  const info = { versionString: dict.CFBundleShortVersionString, buildNumber: dict.CFBundleVersion, bundleId: dict.CFBundleIdentifier };
  if (!info.versionString || !info.buildNumber) throw new Error('The .ipa Info.plist has no CFBundleShortVersionString / CFBundleVersion.');
  return info;
}
