"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATCH_QUEUES = exports.MAP_PACKAGE_LIMIT = exports.MAPS = exports.LADDER_FFA_COLOURS = exports.LADDER_TEAM_COLOURS = exports.LADDER_RULES = exports.COLOURS = exports.COLOUR_DEFINITIONS = exports.FACTIONS = exports.STEAM_LINK_TTL_MS = exports.AUTO_LINK_TTL_MS = exports.NATIVE_HOST_TTL_MS = exports.CLIENT_VERSION = exports.PROTOCOL = void 0;
exports.isSteamLobbyId = isSteamLobbyId;
// Protocol version belongs to this launcher, not to the SC2 executable.
exports.PROTOCOL = 9;
exports.CLIENT_VERSION = '0.38.6';
exports.SUPPORT_URL = 'https://supcom2reforged.com/support';
exports.NATIVE_HOST_TTL_MS = 20_000;
exports.AUTO_LINK_TTL_MS = 12_000;
exports.STEAM_LINK_TTL_MS = 15 * 60 * 1000;
function isSteamLobbyId(value) {
    return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}
exports.FACTIONS = ['UEF', 'Cybran', 'Illuminate'];
// Retail strategic icon RGB values (GameColors.FactionColors[].icon), not unit paint.
// Stable native IDs: retain retail 0–9; Reforged adds 10–27; retired Light Pink/Light Purple slots become Sky Blue/Lime Green.
exports.COLOUR_DEFINITIONS = [
    { id: 'blue', name: 'Blue', rgb: '#146fcd', nativeId: 0 },
    { id: 'green', name: 'Green', rgb: '#1bdd1b', nativeId: 1 },
    { id: 'red', name: 'Red', rgb: '#ff0000', nativeId: 2 },
    { id: 'purple', name: 'Purple', rgb: '#b061fa', nativeId: 3 },
    { id: 'tan', name: 'Tan', label: 'Brown', rgb: '#a26b25', nativeId: 4 },
    { id: 'gray', name: 'Gray', label: 'White', rgb: '#deddd1', nativeId: 5 },
    { id: 'olive', name: 'Olive', label: 'Olive Green', rgb: '#92b220', nativeId: 6 },
    { id: 'cyan', name: 'Cyan', label: 'Teal Blue', rgb: '#00ffcc', nativeId: 7 },
    { id: 'yellow', name: 'Yellow', rgb: '#ffe600', nativeId: 8 },
    { id: 'orange', name: 'Orange', rgb: '#ff8000', nativeId: 9 },
    { id: 'pink', name: 'Pink', rgb: '#f0429d', nativeId: 10 },
    { id: 'lavender', name: 'Lavender', rgb: '#b8a4e3', nativeId: 11 },
    { id: 'maroon', name: 'Maroon', rgb: '#800000', nativeId: 12 },
    { id: 'dark-yellow', name: 'Dark Yellow', rgb: '#c2a000', nativeId: 13 },
    { id: 'navy-blue', name: 'Navy Blue', rgb: '#173568', nativeId: 14 },
    { id: 'gun-metal-gray', name: 'Gun Metal Gray', rgb: '#586d78', nativeId: 15 },
    { id: 'sky-blue', name: 'Sky Blue', rgb: '#66c7ff', nativeId: 16 },
    { id: 'light-gray', name: 'Light Gray', rgb: '#b4bdc6', nativeId: 17 },
    { id: 'salmon', name: 'Salmon', rgb: '#fa8072', nativeId: 18 },
    { id: 'lime-green', name: 'Lime Green', rgb: '#a6f000', nativeId: 19 },
    { id: 'mint-green', name: 'Mint Green', rgb: '#7ff0bc', nativeId: 20 },
    { id: 'light-tan', name: 'Light Tan', label: 'Tan', rgb: '#d2b48c', nativeId: 21 },
    { id: 'crimson-red', name: 'Crimson Red', rgb: '#dc143c', nativeId: 22 },
    { id: 'indigo', name: 'Indigo', rgb: '#5533bb', nativeId: 23 },
    { id: 'charcoal', name: 'Charcoal', rgb: '#4a4d54', nativeId: 24 },
    { id: 'tangerine', name: 'Tangerine', rgb: '#ffb600', nativeId: 25 },
    { id: 'magenta', name: 'Magenta', rgb: '#e600cc', nativeId: 26 },
    { id: 'sand', name: 'Sand', rgb: '#e5ad97', nativeId: 27 },
    { id: 'mellow-yellow', name: 'Mellow Yellow', rgb: '#faff00', nativeId: 28 },
    { id: 'forest-green', name: 'Forest Green', rgb: '#2d4715', nativeId: 29 }
];
exports.COLOURS = exports.COLOUR_DEFINITIONS.map(c => c.name);
/** Native option keys and values, verified in the supplied lobbyOptions.lua. */
exports.LADDER_RULES = {
    Victory: 'demoralization', TeamSpawn: 'fixed', UnitCap: '1000', NoRushOption: 'Off',
    FogOfWar: 'explored', GameSpeed: 'normal', CheatsEnabled: 'false', Observers: 'Allowed', PrebuiltUnits: 'Off'
};
exports.LADDER_TEAM_COLOURS = [
    ['Blue', 'Sky Blue', 'Lavender', 'Purple'], ['Red', 'Crimson Red', 'Orange', 'Yellow']
];
exports.LADDER_FFA_COLOURS = ['Blue', 'Red', 'Green', 'Yellow', 'Purple', 'Cyan', 'Orange', 'Gray'];
// These are lobby labels only until an adapter maps them to validated game IDs.
exports.MAPS = ['Open Palms', 'Seton’s Clutch', 'Fields of Isis'];
exports.MAP_PACKAGE_LIMIT = 512 * 1024 * 1024;
exports.MATCH_QUEUES = { '1v1': { players: 2, teamSize: 1, label: '1v1' }, '2v2': { players: 4, teamSize: 2, label: '2v2' }, '3v3': { players: 6, teamSize: 3, label: '3v3' }, '4v4': { players: 8, teamSize: 4, label: '4v4' }, 'ffa3': { players: 3, teamSize: 1, label: 'FFA · 3' }, 'ffa4': { players: 4, teamSize: 1, label: 'FFA · 4' }, 'ffa5': { players: 5, teamSize: 1, label: 'FFA · 5' }, 'ffa6': { players: 6, teamSize: 1, label: 'FFA · 6' }, 'ffa7': { players: 7, teamSize: 1, label: 'FFA · 7' }, 'ffa8': { players: 8, teamSize: 1, label: 'FFA · 8' } };

exports.COMMUNITY_LINKS = Object.freeze({ discord: 'https://discord.gg/AamFRnCEJa', patreon: 'https://patreon.com/SupremeCommander2Reforged', kofi: 'https://ko-fi.com/supcom2reforged' });
