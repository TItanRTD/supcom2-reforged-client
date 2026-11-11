"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareLobbyAssets = prepareLobbyAssets;
const replay_terrain_1 = require("./replay-terrain");
const replay_version_1 = require("./replay-version");
const research_publication_1 = require("../server/research-publication");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const profile_catalog_1 = require("./profile-catalog");
let cached = null;
// Match the native ZIP reader; reject unsupported output before writing it.
const MAX_INTERFACE_ARCHIVE = 144 * 1024 * 1024, MAX_INTERFACE_TOC = 16 * 1024 * 1024;
const hash = (b) => (0, node_crypto_1.createHash)('sha256').update(b).digest('hex');
async function ordinary(p) { if ((await (0, promises_1.lstat)(p)).isSymbolicLink())
    throw Error('Lobby assets must not be symbolic links.'); }
async function atomic(p, bytes) { const temp = p + '.' + (0, node_crypto_1.randomUUID)() + '.tmp'; try {
    await (0, promises_1.writeFile)(temp, bytes, { flag: 'wx' });
    await (0, promises_1.rename)(temp, p);
}
finally {
    await (0, promises_1.rm)(temp, { force: true });
} }
/** Writes only the two existing probe assets in the explicitly selected test copy.
 * A fixed journal supports recovery between the two individual atomic renames. */
async function prepareLobbyAssets(root, assets, custom, modernHud = false, hudScale = 1, legacyReplay = false, progress = () => { }, research, expected, recoverUnknown = false, replayTarget, replayPresentation = false, replayFile,gameplay) {
    if(gameplay){gameplay=require('../server/gameplay').verifyPatch(gameplay);if(research&&research.id!==gameplay.research?.id)throw Error('Research differs from the selected gameplay patch.');research=gameplay.research;if(!custom||!modernHud||legacyReplay)throw Error('Selected gameplay requires the Reforged game interface.');}
    const targetRevision = (0, replay_version_1.validateReplayRevision)(replayTarget);
    if (replayPresentation && (!custom || !modernHud))
        throw Error('Replay presentation requires the modern isolated interface.');
    if (targetRevision !== 'current' && (!custom || !modernHud || legacyReplay))
        throw Error('Historical simulation requires Reforged replay mode.');
    if (research) {
        research = (0, research_publication_1.verifyRuleset)(research);
        if (legacyReplay || !custom || !modernHud)
            throw Error('Research changes require a Reforged custom game.');
    }
    if (legacyReplay && (!custom || !modernHud))
        throw Error('Legacy replay UI requires the modern presentation profile.');
    if (!Number.isFinite(hudScale) || hudScale < 0.75 || hudScale > 2.5 || Math.round(hudScale * 8) !== hudScale * 8)
        throw Error('Invalid HUD scale.');
    root = await (0, promises_1.realpath)(root);
    if (root.toLowerCase().split(node_path_1.default.sep).includes('steamapps'))
        throw Error('Custom lobby tests require the separate game copy.');
    const data = node_path_1.default.join(root, 'gamedata');
    await ordinary(data);
    const sourcePaths = [node_path_1.default.join(data, 'ui.scd'), node_path_1.default.join(root, 'toc.original.win.bdf'), node_path_1.default.join(data, 'ui.scd.enc')];
    for (const p of sourcePaths)
        await ordinary(p);
    progress('preparing-read-interface-inputs');
    const inputs = await Promise.all(sourcePaths.map(p => (0, promises_1.readFile)(p)));
    const luaPath = node_path_1.default.join(data, 'lua.scd');
    let hudLua;
    if (modernHud) {
        await ordinary(luaPath);
        hudLua = await (0, promises_1.readFile)(luaPath);
        if (hash(hudLua) !== require(node_path_1.default.join(assets, 'hud', 'assets.cjs')).LUA_HASH)
            throw Error('The game Lua archive differs from the inspected SupCom 2 baseline; HUD assets were not changed.');
    }
    const terrain = replayPresentation && replayFile ? await (0, replay_terrain_1.collectReplayTerrain)(root, await (0, replay_terrain_1.replayTerrainMap)(replayFile), progress) : undefined;
    const builder = require(node_path_1.default.join(assets, 'lobby', 'indexed-probe.cjs'));
    const artRoot = node_path_1.default.join(assets, 'lobby', 'art');
    const manifest = JSON.parse(await (0, promises_1.readFile)(node_path_1.default.join(artRoot, 'art-manifest.json'), 'utf8'));
    if (manifest.format !== 's2r-lobby-art-v1' || !Array.isArray(manifest.textures) || manifest.textures.length !== 90)
        throw Error('The packaged lobby artwork manifest is invalid.');
    const textures = await Promise.all(manifest.textures.map(async (t) => {
        if (!/^rf[a-z0-9_]*\.dds$/.test(t.name))
            throw Error('Invalid packaged lobby texture name.');
        const bytes = await (0, promises_1.readFile)(node_path_1.default.join(artRoot, t.name));
        if (hash(bytes) !== t.sha256 || bytes.toString('ascii', 0, 4) !== 'DDS ' || bytes.readUInt32LE(12) !== t.height || bytes.readUInt32LE(16) !== t.width)
            throw Error('Packaged lobby artwork is missing or changed: ' + t.name);
        return { name: 'textures/ui/common/pc/frontend/' + t.name, data: bytes };
    }));
    const key = [node_path_1.default.resolve(assets), ...inputs.map(hash), ...textures.map(t => hash(t.data)), hudLua ? hash(hudLua) : '', terrain ? terrain.name + ':' + terrain.sha256 : ''].join(':');
    if (!cached || cached.key !== key)
        cached = { key, variants: new Map() };
    const cache = cached.variants;
    const build = (id, options, b = builder) => { if (!cache.has(id)) {
        const result = b.build(...inputs, options);
        // A full roster archive holds substantially more data than a regular HUD.
        for (const [key, entry] of cache) {
            if (entry.archive.length > 96 * 1024 * 1024)
                cache.delete(key);
        }
        if (cache.size >= 4)
            cache.delete(cache.keys().next().value);
        cache.set(id, result);
    } return cache.get(id); };
    const control = () => build('control', false);
    const modern = (revision, scale, readOnlyProfile = legacyReplay, rules = revision === targetRevision && !readOnlyProfile ? research : undefined,game=gameplay) => build('hud-' + revision + '-' + scale + (readOnlyProfile ? '-legacy-replay' : '') + (rules ? '-research-' + rules.id : '')+'-game-'+(game?.id??game?.profileId??''), { ...(game?{gameplay:game}:{}),layout: true, textures, hud: hudLua, hudScale: scale, ...(rules ? { research: rules } : {}), ...(readOnlyProfile && ['current', '0383', '0382', '0381', '0380', '03721', '03720', '03719', '03718', '03717', '03716', '03715', '03714', '03713', '03712', '03711', '03710', '0379', '0378', '0377', '0376', '0375', '0374', '0373', '0372', '0371', '0370', '03619', '03618', '03617', '03616', '03615', '03614', '03613', '03612', '03611', '03610', '0369', '0368', '0367', '0366', '0365', '0364', '0363', '0362', '0361', '0355', '0354', '0353', '0352', '0351', '0350', '0343', '0342', '0341', '0340', '0337', '0336', '0335', '0334', '0333', '0332', '0331', '0327', '0326', '0325', '0324', '0323', '0322', '0321', '0320', '0313', '0312', '0311', '0310', '0306', '0305', '0304', '0301', '0300', '0292', '0291', '0290', '0282', '0280', '02733', '02732', '02731', '02730', '02729', '02728', '02727', '02726', '02725', '02723', '02722', '02721', '02720', '02719', '02711'].includes(revision) ? { legacyReplay: true } : {}), ...((revision==='current'||revision==='0383'||revision==='0382'||revision==='0381'||revision==='0380'||revision==='03721'||revision==='03720'||revision==='03719'||revision==='03718'||revision==='03717'||revision==='03716'||revision==='03715'||revision==='03714'||revision==='03713'||revision==='03712'||revision==='03711'||revision==='03710'||revision==='0379'||revision==='0378'||revision==='0377'||revision==='0376'||revision==='0375'||revision==='0374'||revision==='0373'||revision==='0372'||revision==='0371'||revision==='0370'||revision==='03619'||revision==='03618'||revision==='03617'||revision==='03616'||revision==='03615'||revision==='03614'||revision==='03613'||revision==='03612'||revision==='03611'||revision==='03610'||revision==='0369'||revision==='0368'||revision==='0367'||revision==='0366'||revision==='0365'||revision==='0364'||revision==='0363'||revision==='0362'||revision==='0361'||revision==='0355')&&!readOnlyProfile ? { playerBadges:true } : {}) }, revision === 'current' ? builder : revision === '0383' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0383.cjs')) : revision === '0382' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0382.cjs')) : revision === '0381' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0381.cjs')) : revision === '0380' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0380.cjs')) : revision === '03721' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03721.cjs')) : revision === '03720' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03720.cjs')) : revision === '03719' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03719.cjs')) : revision === '03718' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03718.cjs')) : revision === '03717' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03717.cjs')) : revision === '03716' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03716.cjs')) : revision === '03715' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03715.cjs')) : revision === '03714' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03714.cjs')) : revision === '03713' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03713.cjs')) : revision === '03712' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03712.cjs')) : revision === '03711' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03711.cjs')) : revision === '03710' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03710.cjs')) : revision === '0379' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0379.cjs')) : revision === '0378' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0378.cjs')) : revision === '0377' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0377.cjs')) : revision === '0376' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0376.cjs')) : revision === '0375' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0375.cjs')) : revision === '0374' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0374.cjs')) : revision === '0373' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0373.cjs')) : revision === '0372' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0372.cjs')) : revision === '0371' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0371.cjs')) : revision === '0370' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0370.cjs')) : revision === '03619' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03619.cjs')) : revision === '03618' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03618.cjs')) : revision === '03617' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03617.cjs')) : revision === '03616' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03616.cjs')) : revision === '03615' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03615.cjs')) : revision === '03614' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03614.cjs')) : revision === '03613' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03613.cjs')) : revision === '03612' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03612.cjs')) : revision === '03611' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03611.cjs')) : revision === '03610' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03610.cjs')) : revision === '0369' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0369.cjs')) : revision === '0368' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0368.cjs')) : revision === '0367' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0367.cjs')) : revision === '0366' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0366.cjs')) : revision === '0365' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0365.cjs')) : revision === '0364' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0364.cjs')) : revision === '0363' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0363.cjs')) : revision === '0362' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0362.cjs')) : revision === '0361' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0361.cjs')) : revision === '0355' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0355.cjs')) : revision === '0354' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0354.cjs')) : revision === '0353' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0353.cjs')) : revision === '0352' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0352.cjs')) : revision === '0351' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0351.cjs')) : revision === '0350' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0350.cjs')) : revision === '0343' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0343.cjs')) : revision === '0342' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0342.cjs')) : revision === '0341' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0341.cjs')) : revision === '0340' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0340.cjs')) : revision === '0337' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0337.cjs')) : revision === '0336' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0336.cjs')) : revision === '0335' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0335.cjs')) : revision === '0334' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0334.cjs')) : revision === '0333' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0333.cjs')) : revision === '0332' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0332.cjs')) : revision === '0331' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0331.cjs')) : revision === '0329' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0329.cjs')) : revision === '0328' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0328.cjs')) : revision === '0327' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0327.cjs')) : revision === '0326' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0326.cjs')) : revision === '0325' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0325.cjs')) : revision === '0324' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0324.cjs')) : revision === '0323' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0323.cjs')) : revision === '0322' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0322.cjs')) : revision === '0321' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0321.cjs')) : revision === '0320' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0320.cjs')) : revision === '0313' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0313.cjs')) : revision === '0312' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0312.cjs')) : revision === '0311' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0311.cjs')) : revision === '0310' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0310.cjs')) : revision === '0306' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0306.cjs')) : revision === '0305' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0305.cjs')) : revision === '0304' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0304.cjs')) : revision === '0301' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0301.cjs')) : revision === '0300' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0300.cjs')) : revision === '0292' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0292.cjs')) : revision === '0291' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0291.cjs')) : revision === '0290' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0290.cjs')) : revision === '0282' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0282.cjs')) : revision === '0280' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0280.cjs')) : revision === '02733' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02733.cjs')) : revision === '02732' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02732.cjs')) : revision === '02731' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02731.cjs')) : revision === '02730' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02730.cjs')) : revision === '02729' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02729.cjs')) : revision === '02728' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02728.cjs')) : revision === '02727' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02727.cjs')) : revision === '02726' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02726.cjs')) : revision === '02725' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02725.cjs')) : revision === '02723' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02723.cjs')) : revision === '02722' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02722.cjs')) : revision === '02721' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02721.cjs')) : revision === '02720' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02720.cjs')) : revision === '02719' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02719.cjs')) : revision === '02711' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02711.cjs')) : revision === '02710' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02710.cjs')) : revision === '0279' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0279.cjs')) : revision === '0278' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0278.cjs')) : revision === '0277' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0277.cjs')) : revision === '0276' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0276.cjs')) : revision === '0275' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0275.cjs')) : revision === '0274' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0274.cjs')) : revision === '0273' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0273.cjs')) : revision === '0272' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0272.cjs')) : revision === '0271' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0271.cjs')) : revision === '0266' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0266.cjs')) : revision === '0265' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0265.cjs')) : revision === '0264' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0264.cjs')) : revision === '0263' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0263.cjs')) : revision === '0262' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0262.cjs')) : revision === '0261' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0261.cjs')) : revision === '0260' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0260.cjs')) : revision === '0252' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0252.cjs')) : revision === '0250' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0250.cjs')) : revision === '0244' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0244.cjs')) : revision === '0243' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0243.cjs')) : revision === '0242' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0242.cjs')) : revision === '0241' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0241.cjs')) : revision === '0240' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0240.cjs')) : (revision === '17' || revision === '18' || revision === '19') ? { build: require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v02316.cjs'))[revision === '19' ? 'buildV19' : revision === '18' ? 'buildV18' : 'buildV17'] } : require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v023' + revision + '.cjs')));
    const replayBuild = (revision, scale, legacy, presentation = '0384', mapTexture, rules,game=gameplay) => build('replay-ui' + presentation + '-' + revision + '-' + scale + '-' + legacy + '-' + (mapTexture ? mapTexture.name + ':' + mapTexture.sha256 : '') + (rules ? '-research-' + rules.id : '')+'-game-'+(game?.id??game?.profileId??''), { ...(game?{gameplay:game}:{}),layout: true, textures, hud: hudLua, hudScale: scale, legacyReplay: legacy, replayPresentation: true, replaySimulationRevision: presentation === revision && ['0350','0351','0352'].includes(presentation) ? 'current' : revision, ...(['0326', '0327', '0328', '0329', '0330', '0331', '0332', '0335', '0336', '0337', '0340', '0341', '0342', '0343', '0350', '0354', '0355', '0360', '0362', '0363', '0364', '0368', '0369', '03610', '03611', '03612', '03613', '03614', '03615', '03616', '03617', '03618', '03619', '0370', '0371', '0372', '0373', '0374', '0375', '0376', '0377', '0378', '0379'].includes(presentation) && mapTexture ? { replayTerrain: [{ name: mapTexture.name, data: mapTexture.data, map: mapTexture.map }] } : {}), ...(rules ? { research: rules } : {}) }, presentation === '0383' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0383.cjs')) : presentation === '0382' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0382.cjs')) : presentation === '0381' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0381.cjs')) : presentation === '0380' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0380.cjs')) : presentation === '03721' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03721.cjs')) : presentation === '03720' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03720.cjs')) : presentation === '03719' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03719.cjs')) : presentation === '03718' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03718.cjs')) : presentation === '03717' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03717.cjs')) : presentation === '03716' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03716.cjs')) : presentation === '03715' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03715.cjs')) : presentation === '03714' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03714.cjs')) : presentation === '03713' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03713.cjs')) : presentation === '03712' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03712.cjs')) : presentation === '03711' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03711.cjs')) : presentation === '03710' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03710.cjs')) : presentation === '0379' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0379.cjs')) : presentation === '0378' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0378.cjs')) : presentation === '0377' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0377.cjs')) : presentation === '0376' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0376.cjs')) : presentation === '0375' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0375.cjs')) : presentation === '0374' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0374.cjs')) : presentation === '0373' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0373.cjs')) : presentation === '0372' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0372.cjs')) : presentation === '0371' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0371.cjs')) : presentation === '0370' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0370.cjs')) : presentation === '03619' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03619.cjs')) : presentation === '03618' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03618.cjs')) : presentation === '03617' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03617.cjs')) : presentation === '03616' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03616.cjs')) : presentation === '03615' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03615.cjs')) : presentation === '03614' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03614.cjs')) : presentation === '03613' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03613.cjs')) : presentation === '03612' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03612.cjs')) : presentation === '03611' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03611.cjs')) : presentation === '03610' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v03610.cjs')) : presentation === '0369' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0369.cjs')) : presentation === '0368' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0368.cjs')) : presentation === '0364' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0364.cjs')) : presentation === '0363' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0363.cjs')) : presentation === '0362' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0362.cjs')) : presentation === '0360' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0361.cjs')) : presentation === '0355' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0355.cjs')) : presentation === '0354' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0354.cjs')) : presentation === '0353' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0353.cjs')) : presentation === '0352' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0352.cjs')) : presentation === '0351' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0351.cjs')) : presentation === '0350' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0350.cjs')) : presentation === '0343' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0343.cjs')) : presentation === '0342' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0342.cjs')) : presentation === '0341' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0341.cjs')) : presentation === '0340' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0340.cjs')) : presentation === '0337' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0337.cjs')) : presentation === '0336' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0336.cjs')) : presentation === '0335' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0335.cjs')) : presentation === '0332' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0334.cjs')) : presentation === '0330' || presentation === '0331' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0331.cjs')) : presentation === '0329' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0329.cjs')) : presentation === '0328' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0328.cjs')) : presentation === '0327' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0327.cjs')) : presentation === '0326' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0326.cjs')) : presentation === '0325' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0325.cjs')) : presentation === '0324' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0324.cjs')) : presentation === '0323' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0323.cjs')) : presentation === '0322' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0322.cjs')) : presentation === '0321' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0321.cjs')) : presentation === '0320' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0320.cjs')) : presentation === '0313' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0313.cjs')) : presentation === '0312' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0312.cjs')) : builder);
    const latest = (scale) => replayPresentation ? replayBuild(targetRevision, scale, legacyReplay, '0384', terrain, research) : custom ? (modernHud ? modern(targetRevision, scale) : build('lobby', { layout: true, textures })) : control();
    const probe = node_path_1.default.join(data, builder.PROBE_NAME), toc = node_path_1.default.join(root, 'toc.win.bdf');
    for (const p of [probe, toc]) {
        await ordinary(p);
        const stat = await (0, promises_1.lstat)(p), limit = p === probe ? MAX_INTERFACE_ARCHIVE : MAX_INTERFACE_TOC;
        if (!stat.isFile() || stat.size > limit)
            throw Object.assign(Error('The prepared interface exceeds its supported file bounds; it was preserved. ' + node_path_1.default.basename(p) + ': ' + stat.size + ' bytes; limit ' + limit + ' bytes.'), { code: 'S2R_INTERFACE_UNKNOWN' });
    }
    const state = node_path_1.default.join(root, 'revival-prepared', 'reforged-lobby-v1');
    try {
        await ordinary(node_path_1.default.dirname(state));
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    await (0, promises_1.mkdir)(state, { recursive: true });
    await ordinary(node_path_1.default.dirname(state));
    await ordinary(state);
    const journal = node_path_1.default.join(state, 'transaction.json');
    let pending = null;
    try {
        await ordinary(journal);
        pending = JSON.parse(await (0, promises_1.readFile)(journal, 'utf8'));
        if (!pending || !['control', 'custom'].includes(pending.target) || Object.keys(pending).length !== 1)
            throw Error('Invalid journal.');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw Error('The custom lobby transaction needs review; no unknown files were overwritten.');
    }
    let previousScale = 1;
    let previousGameId;
    let previousResearchId;
    let previousReplay;
    try {
        await ordinary(node_path_1.default.join(state, 'lobby-manifest.json'));
        const previous = JSON.parse(await (0, promises_1.readFile)(node_path_1.default.join(state, 'lobby-manifest.json'), 'utf8'));
        previousGameId=previous?.hud?.gameplay?.patchId;
        previousResearchId = typeof previous?.hud?.researchId === 'string' ? previous.hud.researchId : undefined;
        const n = previous?.hud?.scale;
        if (typeof n === 'number' && n >= 0.75 && n <= 2.5 && Math.round(n * 8) === n * 8)
            previousScale = n;
        if (['replay-presentation-0312', 'replay-presentation-0313', 'replay-presentation-0320', 'replay-presentation-0321', 'replay-presentation-0322', 'replay-presentation-0323', 'replay-presentation-0324', 'replay-presentation-0325', 'replay-presentation-0326', 'replay-presentation-0327', 'replay-presentation-0328', 'replay-presentation-0329', 'replay-presentation-0330', 'replay-presentation-0331', 'replay-presentation-0332', 'replay-presentation-0335', 'replay-presentation-0336', 'replay-presentation-0337', 'replay-presentation-0340', 'replay-presentation-0341', 'replay-presentation-0342', 'replay-presentation-0343', 'replay-presentation-0350', 'replay-presentation-0351', 'replay-presentation-0352', 'replay-presentation-0353', 'replay-presentation-0354', 'replay-presentation-0355', 'replay-presentation-0360', 'replay-presentation-0362', 'replay-presentation-0363', 'replay-presentation-0364', 'replay-presentation-0368', 'replay-presentation-0369', 'replay-presentation-03610', 'replay-presentation-03611', 'replay-presentation-03612', 'replay-presentation-03613', 'replay-presentation-03614', 'replay-presentation-03615', 'replay-presentation-03616', 'replay-presentation-03617', 'replay-presentation-03618', 'replay-presentation-03619', 'replay-presentation-0370', 'replay-presentation-0371', 'replay-presentation-0372', 'replay-presentation-0373', 'replay-presentation-0374', 'replay-presentation-0375', 'replay-presentation-0376', 'replay-presentation-0377', 'replay-presentation-0378', 'replay-presentation-0379', 'replay-presentation-03710', 'replay-presentation-03711', 'replay-presentation-03712', 'replay-presentation-03713', 'replay-presentation-03714', 'replay-presentation-03715', 'replay-presentation-03716', 'replay-presentation-03717', 'replay-presentation-03718', 'replay-presentation-03719', 'replay-presentation-03720', 'replay-presentation-03721', 'replay-presentation-0380', 'replay-presentation-0381', 'replay-presentation-0382', 'replay-presentation-0383', 'replay-presentation-0384'].includes(previous?.hud?.mode) && typeof previous.hud.originalSimulation === 'boolean') {
            previousReplay = { revision: previous.hud.simulationRevision === 'current' && ['replay-presentation-0350', 'replay-presentation-0351', 'replay-presentation-0352'].includes(previous.hud.mode) ? previous.hud.mode.slice('replay-presentation-'.length) : (0, replay_version_1.validateReplayRevision)(previous.hud.simulationRevision), legacy: previous.hud.originalSimulation, presentation: previous.hud.mode.slice('replay-presentation-'.length), terrainMap: (0, replay_terrain_1.terrainMap)(previous.hud.replayTerrain?.map) };
        }
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const scales = [...new Set([hudScale, previousScale])].filter(n => n !== 1);
    const current = await Promise.all([(0, promises_1.readFile)(toc), (0, promises_1.readFile)(probe)]);
    const same = (r) => current[0].equals(r.toc) && current[1].equals(r.archive);
    progress('preparing-check-interface-cache');
    const catalog = await (0, profile_catalog_1.readProfileCatalog)(assets, inputs, hudLua, progress);
    const actualTocHash = hash(current[0]), actualArchiveHash = hash(current[1]);
    const installed = catalog?.profiles.find(p => actualTocHash === p.tocSha256 && actualArchiveHash === p.archiveSha256);
    progress('preparing-check-interface-cache', installed ? 'Recognized interface ' + installed.revision : 'No packaged match; checking saved interface state');
    const baselineRecord = catalog?.profiles.find(p => p.revision === 'control');
    const backupVerified = async () => {
        if (!baselineRecord)
            return false;
        try {
            for (const [name, expected] of [['control-toc.win.bdf', baselineRecord.tocSha256], ['control-probe.scd', baselineRecord.archiveSha256]]) {
                const file = node_path_1.default.join(state, name);
                await ordinary(file);
                if (hash(await (0, promises_1.readFile)(file)) !== expected)
                    return false;
            }
            return true;
        }
        catch {
            return false;
        }
    };
    // An in-memory expectation comes only from this client's completed worker.
    // Revalidate the packaged catalog/source and both actual files before reuse.
    if ((gameplay || research || replayPresentation) && expected && catalog && expected.source === catalog.source && (expected.terrainSha ?? '') === (terrain ? terrain.name + ':' + terrain.sha256 : '') && (expected.revision ?? 'current') === targetRevision && expected.custom === custom && expected.modernHud === modernHud && expected.scale === hudScale && expected.legacyReplay === legacyReplay && expected.gameplayId===(gameplay?.id??'') && expected.researchId === (research?.id ?? '') && !!expected.replayPresentation === replayPresentation && actualTocHash === expected.profile.tocSha256 && actualArchiveHash === expected.profile.archiveSha256 && await backupVerified()) {
        progress('preparing-check-interface-cache', replayPresentation ? 'Verified current replay presentation' : 'Verified gameplay ' + (gameplay?.id??research?.id??'default').slice(0,12));
        return { ...expected.profile, cache: expected };
    }
    const unknownInterface = () => Object.assign(Error('This copy has an unrecognized prepared interface. Its files were preserved.'), { code: 'S2R_INTERFACE_UNKNOWN' });
    const pendingKnown = pending && catalog?.profiles.some(p => p.tocSha256 === actualTocHash) && catalog.profiles.some(p => p.archiveSha256 === actualArchiveHash);
    let previousResearchKnown = false;
    let previousResearch = research?.id === previousResearchId ? research : undefined;
    if (!previousResearch && previousResearchId) {
        // The saved rules are only reconstruction inputs, never authority to overwrite.
        // Both actual interface files must match a packaged generator byte for byte.
        try {
            const file = node_path_1.default.join(state, 'published-research.json'), st = await (0, promises_1.lstat)(file);
            if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 8_388_608) {
                const rules = (0, research_publication_1.verifyRuleset)(JSON.parse(await (0, promises_1.readFile)(file, 'utf8')));
                if (rules.id === previousResearchId)
                    previousResearch = rules;
            }
        }
        catch { }
    }
    let previousGameplay,previousGameplayKnown=false;
    if(previousGameId){try{const f=node_path_1.default.join(state,'published-gameplay.json'),st=await (0,promises_1.lstat)(f);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=8388608){const p=require('../server/gameplay').verifyPatch(JSON.parse(await (0,promises_1.readFile)(f,'utf8')));if(p.id===previousGameId)previousGameplay=p;}}catch{}}
    if (!installed && previousGameplay && !previousReplay) {
        previousGameplayKnown = same(modern('current', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('0383', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('0382', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('0381', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('0380', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03721', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03720', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03719', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03718', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03717', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03716', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03715', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03714', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03713', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03712', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03711', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('03710', previousScale, false, previousGameplay.research, previousGameplay))
            || same(modern('0379', previousScale, false, previousGameplay.research, previousGameplay))
            || (previousGameplay.compiler === '0370' && [
                '0378','0377','0376','0375','0374',
            ].some(revision => same(modern(revision, previousScale, false, previousGameplay.research, previousGameplay))));
    }
    let previousReplayKnown = false;
    if (!installed && previousReplay && recoverUnknown && !replayPresentation && !previousGameplay)
        throw unknownInterface();
    if (!installed && previousReplay && hudLua) {
        progress('preparing-check-replay-interface', 'Checking saved replay presentation ' + previousReplay.presentation);
        const legacyTerrain = Number(previousReplay.presentation) < 335;
        const previousTerrain = !legacyTerrain && previousReplay.terrainMap === terrain?.map ? terrain : previousReplay.terrainMap ? await (0, replay_terrain_1.collectReplayTerrain)(root, previousReplay.terrainMap, progress, legacyTerrain) : undefined;
        const previous = replayBuild(previousReplay.revision, previousScale, previousReplay.legacy, previousReplay.presentation, previousTerrain, previousResearch,previousGameplay);
        previousReplayKnown = (!previousResearchId || !!previousResearch) && same(previous);
    }
    // Check the previous replay first, avoiding five expensive non-replay reconstructions.
    if (!installed && previousResearch && hudLua && !previousReplayKnown) {
        const recoveryRevisions = recoverUnknown ? [targetRevision] : ['current', '0362', '0361', '0355', '0354', '0353', '0352', '0351', '0350', '0343', '0342', '0341', '0340', '0337', '0336', '0335', '0334', '0333', '0332', '0331', '0329', '0328', '0327', '0326'];
        previousResearchKnown = recoveryRevisions.some(revision => {
            progress('preparing-check-research-interface', 'Checking saved research with interface ' + revision);
            return same(modern(revision, previousScale, false, previousResearch));
        });
    }
    // The catalog contains release-generated expectations, never a hash supplied by
    // mutable game state. Current files and active packaged generators/art are hashed.
    const needsRoster = ['0379', '03711', '03712', '03714', '03715', '03716', '03717', '03718', '03721', '0382'].includes(gameplay?.compiler);
    const hasRoster = Array.isArray(installed?.manifest.hud?.unitHandoff);
    if (!gameplay?.aiRevision && !installed?.manifest.hud?.gameplay?.aiRevision && needsRoster === hasRoster && (!gameplay || !research && ['vanilla-plus','reforged-balance'].includes(gameplay.profileId)) && !research && !replayPresentation && !pending && installed?.revision === targetRevision && !installed.superseded && installed.custom === custom && installed.modernHud === modernHud && installed.scale === hudScale && installed.legacyReplay === legacyReplay && await backupVerified()) {
        const hud=modernHud?structuredClone(installed.manifest.hud):undefined;
        if(gameplay){
            // A packaged baseline can be reused only for the same roster.
            // The published patch ID is metadata when research data is identical.
            if(!hud?.gameplay?.simulationHash)throw Error('Packaged gameplay proof is missing.');
            hud.gameplay={...hud.gameplay,profileId:gameplay.profileId,patchId:gameplay.id,version:gameplay.version};
            await atomic(node_path_1.default.join(state,'published-gameplay.json'),JSON.stringify(gameplay));
            await atomic(node_path_1.default.join(state,'lobby-manifest.json'),JSON.stringify({...installed.manifest,hud}));
            progress('preparing-check-interface-cache','Verified packaged gameplay '+gameplay.profileId);
        }
        const profile={custom,tocSha256:installed.tocSha256,archiveSha256:installed.archiveSha256,...(hud?{hud}:{})};
        return {...profile,...(gameplay?{cache:{source:catalog.source,terrainSha:'',replayPresentation:false,revision:targetRevision,custom,modernHud,scale:hudScale,legacyReplay,gameplayId:gameplay.id,researchId:'',profile}}:{})};
    }
    progress('preparing-build-interface', 'HUD scale ' + hudScale);
    const target = latest(hudScale);
    if (target.archive.length > MAX_INTERFACE_ARCHIVE || target.toc.length > MAX_INTERFACE_TOC)
        throw Error('The generated interface exceeds the supported file bounds; existing game files were preserved.');
    if (replayPresentation && terrain)
        target.manifest.hud.replayTerrain = { map: terrain.map, sha256: terrain.sha256, source: terrain.source, embedded: terrain.embedded };
    // The common launch verifies the actual two files against the current generated
    // overlay. Historical reconstruction is needed only for an older installation.
    const checked = [target];
    function* candidates() {
        yield control();
        yield build('labels', true);
        if (hudLua) {
            for (const n of [...new Set([hudScale, previousScale, 1])]) {
                yield modern('current', n);
                yield modern('current', n, !legacyReplay);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('0383', n, false);
                yield modern('0383', n, true);
                yield modern('0382', n, false);
                yield modern('0382', n, true);
                yield modern('0381', n, false);
                yield modern('0381', n, true);
                yield modern('0380', n, false);
                yield modern('0380', n, true);
                yield modern('03721', n, false);
                yield modern('03721', n, true);
                yield modern('03720', n, false);
                yield modern('03720', n, true);
                yield modern('03719', n, false);
                yield modern('03719', n, true);
                yield modern('03718', n, false);
                yield modern('03718', n, true);
                yield modern('03717', n, false);
                yield modern('03717', n, true);
                yield modern('03716', n, false);
                yield modern('03716', n, true);
                yield modern('03715', n, false);
                yield modern('03715', n, true);
                yield modern('03714', n, false);
                yield modern('03714', n, true);
                yield modern('03713', n, false);
                yield modern('03713', n, true);
                yield modern('03712', n, false);
                yield modern('03712', n, true);
                yield modern('03711', n, false);
                yield modern('03711', n, true);
                yield modern('03710', n, false);
                yield modern('03710', n, true);
                yield modern('0379', n, false);
                yield modern('0379', n, true);
                yield modern('0378', n, false);
                yield modern('0378', n, true);
                yield modern('0377', n, false);
                yield modern('0377', n, true);
                yield modern('0376', n, false);
                yield modern('0376', n, true);
                yield modern('0375', n, false);
                yield modern('0375', n, true);
                yield modern('0374', n, false);
                yield modern('0374', n, true);
                yield modern('0373', n, false);
                yield modern('0373', n, true);
                yield modern('0372', n, false);
                yield modern('0372', n, true);
                yield modern('0371', n, false);
                yield modern('0371', n, true);
                yield modern('0370', n, false);
                yield modern('0370', n, true);
                yield modern('03619', n, false);
                yield modern('03619', n, true);
                yield modern('03618', n, false);
                yield modern('03618', n, true);
                yield modern('03617', n, false);
                yield modern('03617', n, true);
                yield modern('03616', n, false);
                yield modern('03616', n, true);
                yield modern('03615', n, false);
                yield modern('03615', n, true);
                yield modern('03614', n, false);
                yield modern('03614', n, true);
                yield modern('03613', n, false);
                yield modern('03613', n, true);
                yield modern('03612', n, false);
                yield modern('03612', n, true);
                yield modern('03611', n, false);
                yield modern('03611', n, true);
                yield modern('03610', n, false);
                yield modern('03610', n, true);
                yield modern('0369', n, false);
                yield modern('0369', n, true);
                yield modern('0368', n, false);
                yield modern('0368', n, true);
                yield modern('0367', n, false);
                yield modern('0367', n, true);
                yield modern('0366', n, false);
                yield modern('0366', n, true);
                yield modern('0365', n, false);
                yield modern('0365', n, true);
                yield modern('0364', n, false);
                yield modern('0364', n, true);
                yield modern('0363', n, false);
                yield modern('0363', n, true);
                yield modern('0362', n, false);
                yield modern('0362', n, true);
                yield modern('0361', n, false);
                yield modern('0361', n, true);
                yield modern('0355', n, false);
                yield modern('0355', n, true);
                yield modern('0354', n, false);
                yield modern('0354', n, true);
                yield modern('0353', n, false);
                yield modern('0353', n, true);
                yield modern('0352', n, false);
                yield modern('0352', n, true);
                yield modern('0351', n, false);
                yield modern('0351', n, true);
                yield modern('0350', n, false);
                yield modern('0350', n, true);
                yield modern('0343', n, false);
                yield modern('0343', n, true);
                yield modern('0342', n, false);
                yield modern('0342', n, true);
                yield modern('0341', n, false);
                yield modern('0341', n, true);
                yield modern('0340', n, false);
                yield modern('0340', n, true);
                yield modern('0337', n, false);
                yield modern('0337', n, true);
                yield modern('0336', n, false);
                yield modern('0336', n, true);
                yield modern('0335', n, false);
                yield modern('0335', n, true);
                yield modern('0334', n, false);
                yield modern('0334', n, true);
                yield modern('0333', n, false);
                yield modern('0333', n, true);
                yield modern('0332', n, false);
                yield modern('0332', n, true);
                yield modern('0331', n, false);
                yield modern('0331', n, true);
                yield modern('0329', n, false);
                yield modern('0329', n, true);
                yield modern('0328', n, false);
                yield modern('0328', n, true);
                yield modern('0327', n, false);
                yield modern('0327', n, true);
                yield modern('0326', n, false);
                yield modern('0326', n, true);
                yield modern('0325', n, false);
                yield modern('0325', n, true);
                yield modern('0324', n, false);
                yield modern('0324', n, true);
                yield modern('0323', n, false);
                yield modern('0323', n, true);
                yield modern('0322', n, false);
                yield modern('0322', n, true);
                yield modern('0321', n, false);
                yield modern('0321', n, true);
                yield modern('0320', n, false);
                yield modern('0320', n, true);
                yield modern('0313', n, false);
                yield modern('0313', n, true);
                yield modern('0312', n, false);
                yield modern('0312', n, true);
                yield modern('0311', n, false);
                yield modern('0311', n, true);
                yield modern('0310', n, false);
                yield modern('0310', n, true);
                yield modern('0306', n, false);
                yield modern('0306', n, true);
                yield modern('0305', n, false);
                yield modern('0305', n, true);
                yield modern('0304', n, false);
                yield modern('0304', n, true);
                yield modern('0301', n, false);
                yield modern('0301', n, true);
                yield modern('0300', n, false);
                yield modern('0300', n, true);
                yield modern('0292', n, false);
                yield modern('0292', n, true);
                yield modern('0291', n, false);
                yield modern('0291', n, true);
                yield modern('0290', n, false);
                yield modern('0290', n, true);
                yield modern('0282', n, false);
                yield modern('0282', n, true);
                yield modern('0280', n, false);
                yield modern('0280', n, true);
                yield modern('02733', n, false);
                yield modern('02733', n, true);
                yield modern('02732', n, false);
                yield modern('02732', n, true);
                yield modern('02731', n, false);
                yield modern('02731', n, true);
                yield modern('02730', n, false);
                yield modern('02730', n, true);
                yield modern('02729', n, false);
                yield modern('02729', n, true);
                yield modern('02728', n, false);
                yield modern('02728', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02727', n, false);
                yield modern('02727', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02726', n, false);
                yield modern('02726', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02725', n, false);
                yield modern('02725', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02723', n, false);
                yield modern('02723', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02722', n, false);
                yield modern('02722', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02721', n, false);
                yield modern('02721', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02720', n, false);
                yield modern('02720', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02719', n, false);
                yield modern('02719', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])]) {
                yield modern('02711', n, false);
                yield modern('02711', n, true);
            }
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('02710', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0279', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0278', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0277', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0276', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0275', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0274', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0273', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0272', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0271', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0266', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0265', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0264', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0263', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0262', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0261', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0260', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0252', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0250', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0244', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0243', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0242', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0241', n);
            for (const n of [...new Set([previousScale, hudScale, 1])])
                yield modern('0240', n);
            for (let revision = 20; revision >= 0; revision--) {
                for (const n of [...new Set([previousScale, hudScale, 1])])
                    if (n === 1 || revision >= 8)
                        yield modern(String(revision), n);
            }
        }
        yield build('lobby', { layout: true, textures });
        yield build('labels', true);
        for (const [revision, count] of [['0221', 90], ['0220', 88], ['0210', 61], ['0200', 59], ['0191', 53], ['0180', 53], ['0160', 53], ['0141', 41], ['014', 29], ['0131', 29], ['013', 29]]) {
            yield build(revision, { layout: true, textures: textures.slice(0, count) }, require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v' + revision + '.cjs')));
        }
        const legacyRoot = node_path_1.default.join(assets, 'lobby', 'legacy-v012'), previousManifest = JSON.parse(readLegacyManifest());
        const previousTextures = previousManifest.textures.map((t) => {
            if (!/^rf[a-z0-9_]*\.dds$/.test(t.name))
                throw Error('Invalid legacy artwork manifest');
            const fs = require('node:fs');
            let data = fs.readFileSync(node_path_1.default.join(artRoot, t.name));
            if (hash(data) !== t.sha256)
                data = fs.readFileSync(node_path_1.default.join(legacyRoot, t.name));
            if (hash(data) !== t.sha256)
                throw Error('Legacy lobby upgrade assets differ from their reviewed bytes');
            return { name: 'textures/ui/common/pc/frontend/' + t.name, data };
        });
        yield build('012', { layout: true, textures: previousTextures }, require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v012.cjs')));
    }
    function readLegacyManifest() { return require('node:fs').readFileSync(node_path_1.default.join(assets, 'lobby', 'legacy-v012', 'art-manifest.json'), 'utf8'); }
    let known = same(target) || !pending && !!installed || !!pendingKnown || previousReplayKnown || previousResearchKnown || previousGameplayKnown;
    if (!known && recoverUnknown) {
        const baseline = control();
        if (same(baseline))
            known = true;
        else
            throw unknownInterface();
    }
    if (!known)
        for (const candidate of candidates()) {
            progress('preparing-check-older-interface', 'Checked ' + checked.length + ' profiles');
            checked.push(candidate);
            if (same(candidate) || (pending && checked.some(r => current[0].equals(r.toc)) && checked.some(r => current[1].equals(r.archive)))) {
                known = true;
                break;
            }
        }
    if (!known)
        throw Error('The prepared lobby files differ from the supported versions. Restore your working UI probe before retrying.');
    if (!await backupVerified()) {
        const baseline = control();
        for (const [name, bytes] of [['control-toc.win.bdf', baseline.toc], ['control-probe.scd', baseline.archive]]) {
            const backup = node_path_1.default.join(state, name);
            try {
                await (0, promises_1.writeFile)(backup, bytes, { flag: 'wx' });
            }
            catch (e) {
                if (e.code !== 'EEXIST')
                    throw e;
                await ordinary(backup);
                if (!(await (0, promises_1.readFile)(backup)).equals(bytes))
                    throw Error('The lobby restore backup differs from the known control.');
            }
        }
    }
    progress('preparing-save-interface');
    if (!same(target)) {
        await atomic(journal, JSON.stringify({ target: custom ? 'custom' : 'control' }));
        await atomic(probe, target.archive);
        await atomic(toc, target.toc);
    }
    if(gameplay)await atomic(node_path_1.default.join(state,'published-gameplay.json'),JSON.stringify(gameplay));
    if (research) {
        const file = node_path_1.default.join(state, 'published-research.json');
        try {
            const st = await (0, promises_1.lstat)(file);
            if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
                throw Error('Invalid saved research file.');
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        await atomic(file, JSON.stringify(research));
    }
    await (0, promises_1.rm)(journal, { force: true });
    await atomic(node_path_1.default.join(state, 'lobby-manifest.json'), JSON.stringify({ ...target.manifest, active: custom ? 'custom' : 'control' }, null, 2));
    const profile = { custom, tocSha256: hash(target.toc), archiveSha256: hash(target.archive), ...(modernHud ? { hud: target.manifest.hud } : {}) };
    return { ...profile, ...((gameplay || research || replayPresentation) && catalog ? { cache: { source: catalog.source, terrainSha: terrain ? terrain.name + ':' + terrain.sha256 : '', replayPresentation, revision: targetRevision, custom, modernHud, scale: hudScale, legacyReplay, gameplayId:gameplay?.id??'',researchId: research?.id ?? '', profile } } : {}) };
}
