'use strict';
// SupCom 2 Revival scene inspector and offline probe builder.
// Uses only Node.js built-ins. Never writes to the source archive or game folder.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const BASELINE = 'fd628cef9a743a554c1c03554328c01fbf3a3d47a55b699fa86abfad0ed105ce';
// The prepared HUD includes 128 DXT5 icons and native icon aliases. Keep bounded reads
// plus additive scout, light-defense and reclamation mesh/material sets.
// The reviewed 0.33.2 payload adds three full TMD models; keep explicit
// 96 MiB compressed, 304 MiB expanded and 16 MiB per-entry bounds for base archives.
// The current owned probe includes three additional complete TMD models.
// Keep an explicit archive cap; individual entries and expanded bytes stay bounded.
const MAX_ARCHIVE = 96 * 1024 * 1024;
const MAX_ENTRY = 16 * 1024 * 1024;
const crcTable = Array.from({length: 256}, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
  return i >>> 0;
});
function crc32(b) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(b);
  let n = 0xffffffff;
  for (const v of b) n = (n >>> 8) ^ crcTable[(n ^ v) & 255];
  return (n ^ 0xffffffff) >>> 0;
}
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function requireThat(ok, why) { if (!ok) throw new Error(why); }
function range(b, start, size) {
  requireThat(Number.isSafeInteger(start) && Number.isSafeInteger(size) && start >= 0 &&
    size >= 0 && start + size <= b.length, 'Truncated or invalid file range');
  return b.subarray(start, start + size);
}
// The complete 0.37.21 roster expands to about 458 MiB.
// Keep the larger allowance restricted to generated roster archives.
const MAX_ROSTER_ARCHIVE = 144 * 1024 * 1024;
function readZip(b, maxEntries=2000, preparedRoster=false, onProgress) {
  let reportedAt = Date.now();
  const archiveLimit = preparedRoster ? MAX_ROSTER_ARCHIVE : MAX_ARCHIVE;
  const expandedLimit = (preparedRoster ? 512 : 304) * 1024 * 1024;
  requireThat(Number.isInteger(maxEntries)&&maxEntries>=1&&maxEntries<=10000,'Invalid ZIP entry bound');
  requireThat(b.length <= archiveLimit, 'Archive is too large for this research tool');
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) {
      eocd = i; break;
    }
  }
  requireThat(eocd >= 0, 'ZIP end record missing');
  requireThat(b.readUInt16LE(eocd + 4) === 0 && b.readUInt16LE(eocd + 6) === 0,
    'Multi-disk ZIP is unsupported');
  const count = b.readUInt16LE(eocd + 10);
  requireThat(count < maxEntries && count === b.readUInt16LE(eocd + 8), 'Invalid ZIP entry count');
  const centralStart = b.readUInt32LE(eocd + 16);
  const centralEnd = centralStart + b.readUInt32LE(eocd + 12);
  requireThat(centralEnd === eocd, 'Unsupported ZIP directory layout');
  const entries = [];
  const seen = new Set();
  let at = centralStart, total = 0;
  for (let i = 0; i < count; i++) {
    range(b, at, 46);
    requireThat(b.readUInt32LE(at) === 0x02014b50, 'Invalid ZIP directory signature');
    const flags = b.readUInt16LE(at + 8), method = b.readUInt16LE(at + 10);
    const compressed = b.readUInt32LE(at + 20), size = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28), extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32), local = b.readUInt32LE(at + 42);
    requireThat(!(flags & 1) && (method === 0 || method === 8), 'Encrypted or unsupported ZIP entry');
    requireThat(size <= MAX_ENTRY && compressed <= MAX_ARCHIVE, 'ZIP entry exceeds limits');
    total += size; requireThat(total <= expandedLimit, 'Expanded archive exceeds limit (' + total + ' bytes; limit ' + expandedLimit + ' bytes)');
    const nameBytes = range(b, at + 46, nameLen);
    const name = nameBytes.toString('utf8');
    const normal = name.replaceAll('\\', '/');
    requireThat(!normal.startsWith('/') && !normal.includes(':') &&
      normal.split('/').every(s => s && s !== '.' && s !== '..'), 'Unsafe archive name');
    requireThat(!seen.has(normal.toLowerCase()), 'Duplicate archive entry');
    seen.add(normal.toLowerCase());
    range(b, local, 30);
    requireThat(b.readUInt32LE(local) === 0x04034b50, 'Invalid ZIP local signature');
    requireThat(b.readUInt16LE(local + 6) === flags && b.readUInt16LE(local + 8) === method,
      'ZIP local/directory disagreement');
    const localNameLen = b.readUInt16LE(local + 26), localExtra = b.readUInt16LE(local + 28);
    requireThat(range(b, local + 30, localNameLen).equals(nameBytes), 'ZIP filename mismatch');
    const dataAt = local + 30 + localNameLen + localExtra;
    requireThat(dataAt + compressed <= centralStart, 'ZIP data overlaps directory');
    const packed = range(b, dataAt, compressed);
    const data = method === 0 ? Buffer.from(packed) :
      zlib.inflateRawSync(packed, {maxOutputLength: MAX_ENTRY});
    requireThat(data.length === size && crc32(data) === b.readUInt32LE(at + 16),
      'ZIP size/CRC check failed: ' + name);
    entries.push({name, data});
    if(typeof onProgress==='function' && (i+1===count || Date.now()-reportedAt>=500)){onProgress(i+1,count);reportedAt=Date.now();}
    at += 46 + nameLen + extraLen + commentLen;
  }
  requireThat(at === centralEnd, 'ZIP directory size mismatch');
  return entries;
}
function writeZip(entries, options={}) {
  const locals = [], central = [];
  let at = 0, centralSize = 0, completed = 0, reportedAt = Date.now();
  for (const {name, data} of entries) {
    const n = Buffer.from(name, 'utf8'), crc = crc32(data);
    const candidate=options.compress?zlib.deflateRawSync(data,{level:6}):data;
    const method=options.compress&&candidate.length<data.length?8:0,packed=method===8?candidate:data;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(method,8); h.writeUInt16LE(33, 12); // DOS date 1980-01-01
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18);
    h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    locals.push(h, n, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method,10); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
    central.push(c, n); centralSize += c.length + n.length;
    at += h.length + n.length + packed.length;
    completed++;
    if(typeof options.onProgress==='function' && (completed===entries.length || Date.now()-reportedAt>=500)){options.onProgress(completed,entries.length);reportedAt=Date.now();}
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, ...central, end]);
}
function readBdf(b) {
  requireThat(b.length >= 32 && b.subarray(0, 4).toString() === 'MFDB', 'Missing MFDB header');
  requireThat(b.readUInt32LE(4) === 7 && b.readUInt32LE(8) === 2 && b.readUInt32LE(12) === 0,
    'Unsupported BDF version');
  const compressed = b.readUInt32LE(16), size = b.readUInt32LE(20);
  requireThat(compressed > 0 && size > 0 && size <= MAX_ENTRY, 'Invalid BDF payload size');
  // Do not assume the complete fixup schema. Search aligned candidates and validate
  // stream length, checksum and expanded length, leaving all unknown bytes intact.
  for (let off = 32; off + compressed <= b.length; off += 32) {
    if (b[off] !== 0x78 || ((b[off] << 8) + b[off + 1]) % 31 !== 0) continue;
    try {
      const result = zlib.inflateSync(b.subarray(off, off + compressed),
        {info: true, maxOutputLength: MAX_ENTRY});
      if (result.buffer.length !== size || result.engine.bytesWritten !== compressed) continue;
      return {raw: result.buffer, offset: off, compressed, size,
        fixupCount: b.readUInt32LE(24), suffixBytes: b.length - off - compressed};
    } catch { /* Not this stream. */ }
  }
  throw new Error('No valid aligned BDF stream matches header lengths');
}
function strings(raw) {
  const result = [];
  const text = raw.toString('latin1');
  for (const m of text.matchAll(/[\x20-\x7e]{4,}\x00/g)) {
    result.push({offset: m.index, value: m[0].slice(0, -1)});
  }
  return result;
}
function eventLinks(raw, ss) {
  // Observed common-control prefix: event count/pointer precedes bounds/name.
  // Return only structurally consistent action arrays; this is a partial schema.
  const byOffset = new Map(ss.map(s => [s.offset, s.value]));
  const links = [];
  for (let nameAt = 20; nameAt + 4 <= raw.length; nameAt += 4) {
    const control = byOffset.get(raw.readUInt32LE(nameAt));
    if (!control || !/^[a-z][a-z0-9_]*$/.test(control)) continue;
    const count = raw.readUInt32LE(nameAt - 12), table = raw.readUInt32LE(nameAt - 8);
    if (!count || count > 64 || table % 4 || table + count * 12 > raw.length) continue;
    const candidate = [];
    let valid = true;
    for (let i = 0; i < count && valid; i++) {
      const eventAt = table + i * 12, eventType = raw.readUInt32LE(eventAt);
      const actions = raw.readUInt32LE(eventAt + 4), at = raw.readUInt32LE(eventAt + 8);
      if (!actions || actions > 32 || at % 4 || at + actions * 8 > raw.length) { valid = false; break; }
      for (let j = 0; j < actions; j++) {
        const action = byOffset.get(raw.readUInt32LE(at + j * 8));
        if (!action || !/^[A-Z][A-Za-z0-9_]+$/.test(action)) { valid = false; break; }
        const parameter = byOffset.get(raw.readUInt32LE(at + j * 8 + 4));
        candidate.push({control, eventType, action, ...(parameter ? {parameter} : {})});
      }
    }
    if (valid) links.push(...candidate);
  }
  return links;
}
function describe(entry) {
  const d = readBdf(entry.data), ss = strings(d.raw);
  return {
    scene: entry.name.replaceAll('\\', '/'), bdfSha256: sha256(entry.data),
    sourceBytes: entry.data.length, payloadOffset: d.offset, payloadBytes: d.size,
    compressedBytes: d.compressed, declaredFixupCount: d.fixupCount,
    opaqueSuffixBytes: d.suffixBytes,
    canvas: {width: d.raw.readUInt32LE(0), height: d.raw.readUInt32LE(4)},
    eventCandidates: ss.filter(s => /^(Skirmish|Request|GameBrowser|CancelHostGame|TogglePrivate|EditHost|HostGame)/.test(s.value)),
    recoveredEventLinks: eventLinks(d.raw, ss),
    strings: ss
  };
}
const PROBES = [
  {scene: 'pc_frontend_mp_host.win.bdf',
    old: '<LOC label_title_0008>HOST GAME', replacement: 'SUPCOM 2 REVIVAL - UI TEST'},
  {scene: 'pc_frontend_skirmish.win.bdf',
    old: '<LOC label_title_ready_0000>READY', replacement: 'READY*'}
];
function patchScene(b, from, to) {
  const d = readBdf(b), raw = Buffer.from(d.raw);
  const needle = Buffer.from(from + '\0', 'ascii'), replacement = Buffer.from(to, 'ascii');
  const at = raw.indexOf(needle);
  requireThat(at >= 0 && raw.indexOf(needle, at + 1) < 0, 'Probe text is absent or ambiguous');
  requireThat(replacement.length <= needle.length - 1, 'Replacement exceeds reserved string space');
  raw.fill(0, at, at + needle.length); replacement.copy(raw, at);
  const comp = zlib.deflateSync(raw, {level: 6});
  // Preserve the entire prefix and opaque suffix, including nonzero suffix data.
  // Only the compressed stream and its alignment padding are reconstructed.
  // Suffix semantics are not yet decoded: this is an offline candidate, not a
  // claim of a game-compatible serializer.
  const oldSuffixAt = Math.ceil((d.offset + d.compressed) / 32) * 32;
  const newSuffixAt = Math.ceil((d.offset + comp.length) / 32) * 32;
  const output = Buffer.concat([b.subarray(0, d.offset), comp,
    Buffer.alloc(newSuffixAt - d.offset - comp.length), b.subarray(oldSuffixAt)]);
  output.writeUInt32LE(comp.length, 16);
  const decoded = readBdf(output);
  assert.deepEqual(decoded.raw, raw);
  assert.deepEqual(output.subarray(newSuffixAt), b.subarray(oldSuffixAt));
  assert.deepEqual(output.subarray(0, 16), b.subarray(0, 16));
  assert.deepEqual(output.subarray(20, d.offset), b.subarray(20, d.offset));
  for (let i = 0; i < raw.length; i++) {
    requireThat((i >= at && i < at + needle.length) || raw[i] === d.raw[i],
      'Unexpected change outside selected string');
  }
  return {data: output, change: {payloadOffset: at, old: from, replacement: to,
    oldCompressedBytes: d.compressed, newCompressedBytes: comp.length,
    originalFileBytes: b.length, candidateFileBytes: output.length,
    oldSuffixAt, newSuffixAt, preservesUnknownSuffixBytes: true,
    suffixMeaningAndGameAcceptanceVerified: false}};
}
function inspect(source) {
  const entries = readZip(source);
  requireThat(entries.length > 0 && entries.every(e => /\.bdf$/i.test(e.name)),
    'Expected an archive containing only scene BDF files');
  return {format: 'supcom2-revival-ui-inspection-v1', archiveSha256: sha256(source),
    matchesInspectedBaseline: sha256(source) === BASELINE, entryCount: entries.length,
    decodedScenes: entries.map(describe)};
}
function probe(source) {
  requireThat(sha256(source) === BASELINE, 'Probe supports only the exact inspected ui.scd; inspect other versions first');
  const entries = readZip(source), changes = [], output = [];
  for (const item of PROBES) {
    const matches = entries.filter(e => e.name.endsWith(item.scene));
    requireThat(matches.length === 1, 'Missing/ambiguous probe scene ' + item.scene);
    const original = matches[0], changed = patchScene(original.data, item.old, item.replacement);
    const events = e => describe(e).eventCandidates.map(s => s.value);
    assert.deepEqual(events({...original, data: changed.data}), events(original));
    output.push({name: original.name, data: changed.data});
    changes.push({scene: original.name, ...changed.change});
  }
  const archive = writeZip(output);
  assert.deepEqual(readZip(archive), output);
  return {archive, manifest: {format: 'supcom2-revival-ui-probe-v1',
    status: 'OFFLINE EXPERIMENT ONLY; NOT GAME-TESTED; DOES NOT INSTALL',
    sourceArchiveSha256: sha256(source), probeArchiveSha256: sha256(archive),
    changes, modifiesNetworking: false, installInstructionsIncluded: false}};
}
function main(args) {
  const [mode, input, destination] = args;
  if (!['inspect', 'probe'].includes(mode) || !input || !destination || args.length !== 3) {
    console.error('Usage: node supcom2-ui.cjs inspect|probe "path-to-ui.scd" "new-output-folder"');
    process.exitCode = 1; return;
  }
  const sourcePath = path.resolve(input), outputPath = path.resolve(destination);
  requireThat(!fs.existsSync(outputPath), 'Output folder already exists; choose a new folder');
  const sourceDir = path.dirname(sourcePath);
  const protectedRoot = path.basename(sourceDir).toLowerCase() === 'gamedata' ? path.dirname(sourceDir) : sourceDir;
  const comparable = p => process.platform === 'win32' ? p.toLowerCase() : p;
  requireThat(comparable(outputPath) !== comparable(protectedRoot) &&
    !comparable(outputPath).startsWith(comparable(protectedRoot) + path.sep),
    'Output must be outside the source/game directory');
  const stat = fs.statSync(sourcePath);
  requireThat(stat.isFile() && stat.size <= MAX_ARCHIVE, 'Input is not a supported-size archive');
  const source = fs.readFileSync(sourcePath);
  // Complete validation before creating output.
  const result = mode === 'inspect' ? inspect(source) : probe(source);
  fs.mkdirSync(outputPath, {recursive: true});
  if (mode === 'inspect') {
    fs.writeFileSync(path.join(outputPath, 'scene-catalog.json'), JSON.stringify(result, null, 2), {flag: 'wx'});
    console.log('Decoded ' + result.entryCount + ' scenes. Wrote scene-catalog.json.');
  } else {
    fs.writeFileSync(path.join(outputPath, 'SupCom2-Revival-UI-Probe.scd'), result.archive, {flag: 'wx'});
    fs.writeFileSync(path.join(outputPath, 'probe-manifest.json'), JSON.stringify(result.manifest, null, 2), {flag: 'wx'});
    console.log('Built offline probe. Your game files were not modified. Do not install it yet.');
  }
}
module.exports = {readZip, writeZip, readBdf, patchScene, inspect, probe, crc32, BASELINE, MAX_ROSTER_ARCHIVE};
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('Stopped: ' + e.message); process.exitCode = 1; }
}

