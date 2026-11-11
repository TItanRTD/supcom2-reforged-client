"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.digest = void 0;
exports.profileSourceDigest = profileSourceDigest;
exports.readProfileCatalog = readProfileCatalog;
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const node_zlib_1 = require("node:zlib");
const model_1 = require("../shared/model");
const digest = (b) => (0, node_crypto_1.createHash)('sha256').update(b).digest('hex');
exports.digest = digest;
/** Hash the actual current generators/art, excluding immutable older snapshots. */
async function profileSourceDigest(assets, progress = () => { }) {
    const hash = (0, node_crypto_1.createHash)('sha256');
    hash.update('profile-source-v3\0');
    const files = [];
    async function walk(directory, relative) {
        const entries = await (0, promises_1.readdir)(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name.startsWith('legacy-') ||
                entry.name.startsWith('historical-') || entry.name.startsWith('frozen-') ||
                entry.name === 'sources' || relative === 'scouts' && entry.name === 'art' ||
                /^(?:indexed-probe|scene-extend-0329)-v/.test(entry.name) ||
                /\.(?:s|c|inc|png|svg|md|txt|html|py)$/.test(entry.name))
                continue;
            const file = node_path_1.default.join(directory, entry.name), name = relative + '/' + entry.name;
            if (entry.isSymbolicLink())
                throw Error('Linked interface assets are not supported.');
            if (entry.isDirectory())
                await walk(file, name);
            else if (entry.isFile())
                files.push({ file, name });
        }
    }
    for (const name of ['hud', 'lobby', 'colors', 'scouts', 'ai'])
        await walk(node_path_1.default.join(assets, name), name);
    let checked = 0, lastReport = Date.now();
    progress('preparing-verify-interface-assets', 'Checking 0/' + files.length + ' interface assets');
    for (let at = 0; at < files.length; at += 16) {
        const batch = files.slice(at, at + 16);
        const checksums = await Promise.all(batch.map(async entry =>
            (0, exports.digest)(await (0, promises_1.readFile)(entry.file))));
        for (let i = 0; i < batch.length; i++) {
            hash.update(batch[i].name + '\0');
            hash.update(checksums[i]);
        }
        checked += batch.length;
        if (checked === files.length || Date.now() - lastReport >= 500) {
            progress('preparing-verify-interface-assets', 'Checked ' + checked + '/' + files.length + ' interface assets');
            lastReport = Date.now();
        }
    }
    return hash.digest('hex');
}
async function readProfileCatalog(assets, inputs, hudLua, progress = () => { }) {
    const unavailable = reason => {
        progress('preparing-profile-cache-status', reason);
        return null;
    };
    try {
        const file = node_path_1.default.join(assets, 'profile-catalog.json.gz'), s = await (0, promises_1.lstat)(file);
        if (!s.isFile() || s.isSymbolicLink() || s.size > 2_000_000)
            return unavailable('Packaged interface catalog has an invalid file type or size');
        const c = JSON.parse((0, node_zlib_1.gunzipSync)(await (0, promises_1.readFile)(file), { maxOutputLength: 16_000_000 }).toString('utf8'));
        if (c.format !== 's2r-profile-catalog-v2' || c.clientVersion !== model_1.CLIENT_VERSION || !Array.isArray(c.profiles) || c.profiles.length > 4096)
            return unavailable('Packaged interface catalog format or version differs');
        if (JSON.stringify(c.inputs) !== JSON.stringify(inputs.map(exports.digest)) || hudLua && c.lua !== (0, exports.digest)(hudLua))
            return unavailable('Original game inputs do not match the interface catalog');
        const source = await profileSourceDigest(assets, progress);
        if (c.source !== source)
            return unavailable('Interface source fingerprint differs; expected ' + c.source + ', actual ' + source);
        if (c.profiles.some((p) => !p || !['current', '0383', '0382', '0381', '0380', '03721', '03720', '03719', '03718', '03717', '03716', '03715', '03714', '03713', '03712', '03711', '03710', '0379', '0378', '0377', '0376', '0375', '0374', '0373', '0372', '0371', '0370', '03619', '03618', '03617', '03616', '03615', '03614', '03613', '03612', '03611', '03610', '0369', '0368', '0367', '0366', '0365', '0364', '0363', '0362', '0361', '0355', '0354', '0353', '0352', '0351', '0350', '0343', '0342', '0341', '0340', '0337', '0336', '0335', '0334', '0333', '0332', '0331', '0329', '0328', '0327', '0326', '0325', '0324', '0323', '0322', '0321', '0320', '0313', '0312', '0311', '0310', '0306', '0305', '0304', '0301', '0300', '0292', '0291', '0290', '0282', '0280', '02733', '02732', '02731', '02730', '02729', '02728', '02727', '02726', '02725', '02723', 'control'].includes(p.revision) || typeof p.custom !== 'boolean' || typeof p.modernHud !== 'boolean' || typeof p.legacyReplay !== 'boolean' || !Number.isFinite(p.scale) || !/^([a-f0-9]{64})$/.test(p.tocSha256) || !/^([a-f0-9]{64})$/.test(p.archiveSha256) || !p.manifest))
            return unavailable('Packaged interface catalog contains an invalid profile');
        progress('preparing-profile-cache-status', 'Verified ' + c.profiles.length + ' interface profiles');
        return c;
    }
    catch (error) {
        return unavailable('Interface catalog could not be read: ' + error.message);
    }
}
