"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const replay_version_1 = require("./replay-version");
const client_paths_1 = require("./client-paths");
const research_icons_1 = require("./research-icons");
const map_download_1 = require("./map-download");
const map_install_1 = require("./map-install");
const research_rules_1 = require("./research-rules");
const replay_provenance_1 = require("./replay-provenance");
const research_1 = require("../shared/research");
const ranked_results_1 = require("./ranked-results");
const { PlaytimeReporter } = require("./playtime");
const windows_crash_1 = require("./windows-crash");
const lobby_services_1 = require("./lobby-services");
const updates_1 = require("./updates");
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const adapter_1 = require("./adapter");
const map_catalog_1 = require("./map-catalog");
const logs_1 = require("./logs");
const model_1 = require("../shared/model");
const native_host_1 = require("./native-host");
const host_preparation_1 = require("./host-preparation");
const replays_1 = require("./replays");
const replay_provenance_2 = require("./replay-provenance");
const lobby_map_1 = require("./lobby-map");
const replay_settings_1 = require("./replay-settings");
const replay_playback_1 = require("./replay-playback");
const mesh_relay_1 = require("./mesh-relay");
const launch_attempt_1 = require("./launch-attempt");
const native_guest_1 = require("./native-guest");
const native_room_1 = require("./native-room");
const native_lobby_1 = require("./native-lobby");
const steam_runtime_1 = require("./steam-runtime");
const map_handoff_1 = require("./map-handoff");
const live_lobby_1 = require("./live-lobby");
const room_share_1 = require("./room-share");
const private_server_1 = require("./private-server");
const serverMode = process.argv.includes('--s2r-server'), publicBoot = process.argv.includes('--s2r-public-boot');
const APP_ID = 'community.sc2.revival';
const linuxSteam = process.platform === 'linux' ? require('./linux-steam') : null;
const steamMailbox = () => node_path_1.default.join(electron_1.app.getPath('userData'), 'steam-launch');
const steamOption = () => linuxSteam.steamLaunchOption(node_path_1.default.join(node_path_1.default.dirname(nativeAssets()), 'linux', 'steam-launch.sh'), steamMailbox());
let serverLock = true;
const dataPaths = (0, client_paths_1.clientPaths)(electron_1.app.getPath('appData'));
// Electron used the package name as its default data directory in older builds.
// Keep an existing client directory when adopting the new package name.
const useClientData = (directory) => (0, client_paths_1.setClientDataDirectory)(directory, (name, value) => electron_1.app.setPath(name, value));
if (!electron_1.app.commandLine.hasSwitch('user-data-dir'))
    useClientData((0, client_paths_1.clientUserData)(electron_1.app.getPath('userData'), dataPaths.client));
const accountDirectory = () => node_path_1.default.join(dataPaths.client, 'server');
if (serverMode) {
    useClientData(dataPaths.manager);
    serverLock = electron_1.app.requestSingleInstanceLock();
    if (!serverLock)
        electron_1.app.quit();
}
if (publicBoot) {
    useClientData(dataPaths.publicStartup);
    serverLock = electron_1.app.requestSingleInstanceLock();
    if (!serverLock)
        electron_1.app.quit();
}
if (linuxSteam && !serverMode && !publicBoot) {
    serverLock = electron_1.app.requestSingleInstanceLock();
    if (!serverLock) electron_1.app.quit();
    electron_1.app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.restore(); win.focus(); } });
}
if (process.platform === 'win32')
    electron_1.app.setAppUserModelId(serverMode ? APP_ID + '.server' : APP_ID);
let tracker = null;
let mapTracker = null;
let monitor = null;
const privateServer = new private_server_1.DesktopRoomServer(undefined, undefined, () => node_path_1.default.join(electron_1.app.getPath('userData'), 'server', 'accounts.json'));
const shares = new room_share_1.HostRoomShare(() => tracker?.get() ?? { lobbyId: null, role: null, status: 'waiting', observedAt: Date.now(), message: 'No host process.' }, room_share_1.roomApi, Date.now, (c, id, s) => { void lobbyMaps.publish(c, id, s); });
const nativeAssets = () => electron_1.app.isPackaged ? node_path_1.default.join(process.resourcesPath, 'native') : node_path_1.default.resolve(__dirname, '../../../native');
let mapCatalog = new map_catalog_1.LocalMapCatalog();
let lobbyMaps = new lobby_map_1.LobbyMapPublisher(id => mapCatalog.metadata(id));
let win = null;
let gamePath = null, protonProfile = null;
let launching = false;
let firewallBusy = false;
let gameProcessId = null;
let udpProbePid = null, udpRun = null, lastUdpObservation = '';
let nativeObservation = new native_room_1.NativeLobbyObservation(), udpListenerAt = 0;
const nativeRelay = new mesh_relay_1.NativeMeshRelayClient();
const nativeRoom = new native_room_1.NativeRoomHost(() => nativeObservation.phase(udpListenerAt, !mapTracker || mapTracker.get().state === 'confirmed' || !!lobbyMaps.current()), room_share_1.roomApi, () => lobbyMaps.listing(nativeObservation.listing()), (c, id, s) => { void lobbyMaps.publish(c, id, s); });
let lastLogPath = null;
let nativeGuestMessage = '', relayLog = null, lastRelayLog = '';
let lastAttemptLog = null;
let currentAttempt = null;
const crashCaptures = new Map();
const ui = node_path_1.default.resolve(__dirname, '../../web/client/index.html');
const uiUrl = (0, node_url_1.pathToFileURL)(ui).href;
const configPath = () => node_path_1.default.join(electron_1.app.getPath('userData'), 'game.json');
const logsPath = () => node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
const replayDirectory = () => node_path_1.default.join(electron_1.app.getPath('userData'), 'replays');
const replayCatalog = new replays_1.LocalReplays(() => [node_path_1.default.join(electron_1.app.getPath('documents'), 'My Games', 'SquareEnix', 'Supreme Commander 2', 'replays'), node_path_1.default.join(electron_1.app.getPath('documents'), 'My Games', 'Gas Powered Games', 'Supreme Commander 2'), ...(protonProfile?.replays ?? []), replayDirectory(), logsPath()]);
let extraReplayFolder;
let replaySettings;
const replayFolderStore = () => replaySettings ??= new replay_settings_1.ReplayFolderStore(node_path_1.default.join(electron_1.app.getPath('userData'), 'replay-library.json'));
function trusted(event) {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl)
        throw new Error('Untrusted IPC sender.');
}
let mapDownloadAbort = null;
function mapProgress(value) { if (win && !win.isDestroyed())
    win.webContents.send('map-package:progress', value); }
async function ensureInstalledMap(context, map, executable) {
    if (mapDownloadAbort)
        throw Error('Another map transfer is active. Wait for it to finish.');
    const controller = new AbortController();
    mapDownloadAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
    try {
        return await (0, map_install_1.ensureGameMap)(context, map, executable, node_path_1.default.join(electron_1.app.getPath('userData'), 'map-packages'), controller.signal, mapProgress);
    }
    finally {
        clearTimeout(timeout);
        if (mapDownloadAbort === controller)
            mapDownloadAbort = null;
    }
}
electron_1.ipcMain.handle('game:ensure-map', async (event, raw) => {
    trusted(event);
    if (!gamePath || launching)
        throw Error('Choose the game installation and close the game before installing a map.');
    const r = raw;
    const context = (0, room_share_1.validateHostRoom)({ ...r, roomId: '00000000-0000-0000-0000-000000000000' });
    if (!r.map || typeof r.map.id !== 'string' || !/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(r.map.id) || !/^[a-f0-9]{64}$/.test(r.map.metadataHash))
        throw Error('Choose a current map-pool entry.');
    await ensureInstalledMap(context, r.map, gamePath);
    return mapCatalog.scan(gamePath);
});
electron_1.ipcMain.handle('map-package:cancel', async (event) => { trusted(event); mapDownloadAbort?.abort(); });
electron_1.ipcMain.handle('map-package:download', async (event, raw) => {
    trusted(event);
    if (mapDownloadAbort)
        throw Error('Another map package is downloading.');
    const request = (0, map_download_1.mapDownload)(raw), controller = new AbortController();
    mapDownloadAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
    try {
        if (!gamePath)
            throw Error('Choose your Supreme Commander 2 installation in Settings first.');
        if (launching)
            throw Error('Close the game before installing maps.');
        const result = await (0, map_install_1.installMapPackage)(request, gamePath, node_path_1.default.join(electron_1.app.getPath('userData'), 'map-packages'), controller.signal, mapProgress);
        await mapCatalog.scan(gamePath);
        return result;
    }
    finally {
        clearTimeout(timeout);
        if (mapDownloadAbort === controller)
            mapDownloadAbort = null;
    }
});
electron_1.ipcMain.handle('research:stock-icons', async (event) => { trusted(event); return gamePath ? (0, research_icons_1.boundedStockResearchIcons)(gamePath) : {}; });
electron_1.ipcMain.handle('research:export', async (event, raw) => { trusted(event); const bytes = JSON.stringify((0, research_1.researchDocument)(raw), null, 2) + '\n'; if (Buffer.byteLength(bytes) > 8388608)
    throw Error('Research draft exceeds 8 MiB.'); const selected = await electron_1.dialog.showSaveDialog(win, { title: 'Export research draft', defaultPath: 'Reforged-Research-Draft.json', filters: [{ name: 'Research draft JSON', extensions: ['json'] }] }); if (selected.canceled || !selected.filePath)
    return { message: 'Research export cancelled.' }; await (0, promises_1.writeFile)(selected.filePath, bytes, 'utf8'); return { message: 'Research draft exported as JSON. Gameplay is unchanged.' }; });
let updates = null;
function clientUpdates() { return updates ??= new updates_1.ClientUpdates(node_path_1.default.join(electron_1.app.getPath('userData'), 'updates'), fetch, electron_1.app.getVersion()); }
electron_1.ipcMain.handle('update:check', async (e, server, token) => { trusted(e); return clientUpdates().check(server, token); });
electron_1.ipcMain.handle('update:download', async (e, server, token) => { trusted(e); return clientUpdates().download(server, token); });
electron_1.ipcMain.handle('update:install', async (e, server) => { trusted(e); if (launching)
    throw Error('Close SupCom 2 before installing a client update.'); if (process.platform !== 'win32')
    throw Error('This release installs on Windows.'); const installer = await clientUpdates().installer(server); const child = (0, node_child_process_1.spawn)(installer, [], { detached: true, stdio: 'ignore', shell: false }); await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref(); electron_1.app.quit(); });
electron_1.ipcMain.handle('update:publish', async (e, value) => { trusted(e); if (!value || typeof value.version !== 'string' || typeof value.notes !== 'string')
    throw Error('Enter release details.'); const selected = await electron_1.dialog.showOpenDialog(win, { title: 'Publish a Reforged client installer', properties: ['openFile'], filters: [{ name: 'Reforged setup', extensions: ['exe'] }] }); if (selected.canceled)
    return { message: 'Publication cancelled.' }; return (0, updates_1.publishClient)(value.server, value.token, value.version, value.notes, selected.filePaths[0]); });
function connectionPath() { return node_path_1.default.join(electron_1.app.getPath('userData'), 'connection.bin'); }
function validateConnection(value) { const p = value; if (!p || typeof p.server !== 'string' || p.server.length > 300 || typeof p.accessKey !== 'string' || p.accessKey.length > 200)
    throw new Error('Invalid saved server connection.'); const u = new URL(p.server); if (!['http:', 'https:'].includes(u.protocol) || u.origin !== p.server)
    throw new Error('Invalid saved server address.'); return { server: p.server, accessKey: p.accessKey }; }
electron_1.ipcMain.handle('connection:save', async (e, value) => { trusted(e); const c = validateConnection(value); if (!electron_1.safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && electron_1.safeStorage.getSelectedStorageBackend() === 'basic_text'))
    throw new Error('Secure connection storage is unavailable.'); await (0, promises_1.writeFile)(connectionPath(), electron_1.safeStorage.encryptString(JSON.stringify(c)), { mode: 0o600 }); });
electron_1.ipcMain.handle('connection:load', async (e) => {
    trusted(e);
    if (electron_1.safeStorage.isEncryptionAvailable()) {
        try {
            return validateConnection(JSON.parse(electron_1.safeStorage.decryptString(await (0, promises_1.readFile)(connectionPath()))));
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw new Error('Saved connection could not be read. Import your connection file again.');
        }
    }
    const configured = await publicSetup().configured();
    if (configured && (configured.phase === 'ready' || configured.phase === 'imported'))
        return { server: 'http://127.0.0.1:47821', accessKey: '' };
    const { ServerSettingsStore } = await Promise.resolve().then(() => __importStar(require('./server-settings')));
    const store = new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json'));
    if (!await store.exists())
        return null;
    const s = await store.load();
    return { server: `http://${s.address}:47820`, accessKey: s.accessKey };
});
electron_1.ipcMain.handle('server:export-public', async (e, domain) => { trusted(e); const { exportPublicDeployment } = await Promise.resolve().then(() => __importStar(require('./public-deployment'))); const selected = await electron_1.dialog.showOpenDialog(win, { title: 'Save public Reforged server setup', properties: ['openDirectory', 'createDirectory'] }); if (selected.canceled)
    return { message: 'Export cancelled.' }; return exportPublicDeployment(domain, selected.filePaths[0], node_path_1.default.resolve(__dirname, '../../'), electron_1.app.isPackaged ? node_path_1.default.join(process.resourcesPath, 'deployment') : node_path_1.default.resolve(__dirname, '../../../deployment')); });
let publicSetupRunning = false;
let setupController = null;
function userClientDirectory() { return dataPaths.client; }
function publicSetup() {
    if (setupController)
        return setupController;
    const { PublicServerSetup } = require('./public-setup');
    const root = node_path_1.default.join(userClientDirectory(), 'public-server');
    setupController = new PublicServerSetup({ root, accounts: accountDirectory(), dist: node_path_1.default.resolve(__dirname, '../../'), templates: electron_1.app.isPackaged ? node_path_1.default.join(process.resourcesPath, 'deployment') : node_path_1.default.resolve(__dirname, '../../../deployment'),
        pause: async () => {
            const { ownerControl } = await Promise.resolve().then(() => __importStar(require('./server-control'))), { ServerSettingsStore } = await Promise.resolve().then(() => __importStar(require('./server-settings'))), { acquireStoreLease } = await Promise.resolve().then(() => __importStar(require('../server/store-lease')));
            const store = new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json')), original = await store.load();
            await privateServer.stop();
            let managed = false;
            try {
                managed = await ownerControl(accountDirectory(), 'pause');
            }
            catch {
                throw Error('The old Server Manager could not pause. Close it, then reopen the updated Reforged client and retry.');
            }
            await store.save({ ...original, startOnClient: false, autoStart: false });
            const resume = async () => { if (managed)
                await ownerControl(accountDirectory(), 'resume');
            else {
                await store.save(original);
                if (original.startOnClient !== false || original.autoStart) {
                    const args = electron_1.app.isPackaged ? ['--s2r-server', '--background'] : [electron_1.app.getAppPath(), '--s2r-server', '--background'];
                    const child = (0, node_child_process_1.spawn)(process.execPath, args, { shell: false, detached: true, stdio: 'ignore' });
                    child.on('error', () => { });
                    child.unref();
                }
            } };
            try {
                const release = await acquireStoreLease(node_path_1.default.join(accountDirectory(), 'accounts.json'));
                return { release, resume };
            }
            catch (e) {
                await resume();
                throw e;
            }
        },
        firewall: process.platform === 'win32' ? async () => { const { execFile } = await Promise.resolve().then(() => __importStar(require('node:child_process'))), { promisify } = await Promise.resolve().then(() => __importStar(require('node:util'))); const script = electron_1.app.isPackaged ? node_path_1.default.join(process.resourcesPath, 'deployment', 'Allow-Firewall.ps1') : node_path_1.default.resolve(__dirname, '../../../deployment/Allow-Firewall.ps1'); try {
            await promisify(execFile)(node_path_1.default.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 120_000, maxBuffer: 16384 });
        }
        catch {
            throw Error('Windows Firewall permission was not completed. Retry setup and allow the Windows prompt, or add the TCP 80/443 rule yourself.');
        } } : undefined,
        enableStartup: async () => { if (process.platform === 'win32')
            electron_1.app.setLoginItemSettings({ name: 'community.sc2.revival.public', openAtLogin: true, path: process.execPath, args: ['--s2r-public-boot'] }); },
        onReady: async (connection) => {
            if (publicBoot)
                return;
            const base = userClientDirectory();
            if (electron_1.safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && electron_1.safeStorage.getSelectedStorageBackend() === 'basic_text')) {
                await (0, promises_1.writeFile)(node_path_1.default.join(base, 'connection.bin'), electron_1.safeStorage.encryptString(JSON.stringify(connection)), { mode: 0o600 });
                try {
                    const old = validateAccount(JSON.parse(electron_1.safeStorage.decryptString(await (0, promises_1.readFile)(node_path_1.default.join(base, 'account.bin')))));
                    const { ServerSettingsStore } = await Promise.resolve().then(() => __importStar(require('./server-settings'))), settings = await new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json')).load();
                    if (old.server === `http://${settings.address}:47820` || old.server === connection.server)
                        await (0, promises_1.writeFile)(node_path_1.default.join(base, 'account.bin'), electron_1.safeStorage.encryptString(JSON.stringify({ ...old, server: connection.server })), { mode: 0o600 });
                }
                catch { /* Sign in once if no remembered token exists. */ }
            }
        }
    });
    return setupController;
}
electron_1.ipcMain.handle('public:status', async (e) => { trusted(e); return publicSetup().status(); });
electron_1.ipcMain.handle('public:begin', async (e, request) => {
    trusted(e);
    if (process.platform !== 'win32')
        throw Error('Automatic setup is supported on the Windows server PC.');
    const { publicHostname } = await Promise.resolve().then(() => __importStar(require('./public-deployment'))), domain = publicHostname(request?.domain), saved = await publicSetup().configured();
    if (!saved) {
        const { ServerSettingsStore } = await Promise.resolve().then(() => __importStar(require('./server-settings'))), settings = await new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json')).load();
        if (request.server !== `http://${settings.address}:47820` || typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token))
            throw Error('Sign in to this PC’s current account server and unlock Admin before the first setup.');
        const response = await fetch(request.server + '/api/admin/status', { headers: { Authorization: 'Bearer ' + request.token }, signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok)
            throw Error('Unlock Admin before setting up the public server.');
        const grant = await response.json();
        if (grant.protocol !== model_1.PROTOCOL || !grant.admin || !Number.isFinite(Date.parse(grant.admin.expiresAt)) || Date.parse(grant.admin.expiresAt) <= Date.now())
            throw Error('The local server did not confirm administrator access.');
    }
    if (request?.changeDomain) {
        if (!saved || request.server !== 'http://127.0.0.1:47821' || typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token))
            throw Error('Sign in to this PC’s owner connection and unlock Admin before changing its domain.');
        const response = await fetch('http://127.0.0.1:47821/api/admin/status', { headers: { Authorization: 'Bearer ' + request.token }, signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok)
            throw Error('Unlock Admin before changing the public domain.');
        const grant = await response.json();
        if (grant.protocol !== model_1.PROTOCOL || !grant.admin || Date.parse(grant.admin.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(grant.admin.expiresAt)))
            throw Error('Administrator access was not confirmed.');
    }
    publicSetupRunning = true;
    try {
        const result = await publicSetup().start(domain, request?.changeDomain === true);
        void publicSetup().whenIdle().finally(() => { publicSetupRunning = false; });
        return result;
    }
    catch (e) {
        publicSetupRunning = false;
        throw e;
    }
});
electron_1.ipcMain.handle('public:recheck', async (e) => { trusted(e); return publicSetup().recheck(); });
electron_1.ipcMain.handle('public:files', async (e) => { trusted(e); const state = await publicSetup().status(); if (!state.canResume)
    throw Error('Start setup first.'); const error = await electron_1.shell.openPath(state.directory); if (error)
    throw Error(error); });
function accountPath() { return node_path_1.default.join(electron_1.app.getPath('userData'), 'account.bin'); }
function validateAccount(value) {
    const a = value;
    if (!a || typeof a.server !== 'string' || a.server.length > 300 || typeof a.username !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(a.username) || typeof a.refreshToken !== 'string' || !/^[a-f0-9]{64}$/.test(a.refreshToken))
        throw new Error('Invalid saved account.');
    const url = new URL(a.server);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== a.server)
        throw new Error('Invalid account server.');
    return a;
}
electron_1.ipcMain.handle('account:load', async (event) => {
    trusted(event);
    if (!electron_1.safeStorage.isEncryptionAvailable())
        return null;
    try {
        return validateAccount(JSON.parse(electron_1.safeStorage.decryptString(await (0, promises_1.readFile)(accountPath()))));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        await (0, promises_1.rm)(accountPath(), { force: true });
        return null;
    }
});
electron_1.ipcMain.handle('account:save', async (event, value) => {
    trusted(event);
    if (value === null) {
        await (0, promises_1.rm)(accountPath(), { force: true });
        return;
    }
    const account = validateAccount(value);
    if (!electron_1.safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && electron_1.safeStorage.getSelectedStorageBackend() === 'basic_text'))
        throw new Error('Secure sign-in storage is unavailable. You are signed in for this session.');
    await (0, promises_1.mkdir)(electron_1.app.getPath('userData'), { recursive: true });
    await (0, promises_1.writeFile)(accountPath(), electron_1.safeStorage.encryptString(JSON.stringify(account)), { mode: 0o600 });
});
electron_1.ipcMain.handle('game:copy-steam-launch-option', event => {
    trusted(event);
    if (!linuxSteam) throw Error('Steam and Proton setup is available on Linux.');
    electron_1.clipboard.writeText(steamOption());
});
electron_1.ipcMain.handle('game:choose', async (event) => {
    trusted(event);
    if (launching) throw Error('Close SupCom 2 before selecting another installation.');
    const result = await electron_1.dialog.showOpenDialog(win, { title: 'Select SupremeCommander2.exe', properties: ['openFile'], filters: [{ name: 'SupCom 2 executable', extensions: ['exe'] }] });
    if (result.canceled)
        return null;
    const inspected = await (0, adapter_1.inspectExecutable)(result.filePaths[0]);
    if (linuxSteam && !(0, steam_runtime_1.isSteamInstallation)(inspected.path))
        throw Error('Select SupremeCommander2.exe from the Steam library’s Supreme Commander 2 bin folder.');
    gamePath = inspected.path;
    if (linuxSteam) protonProfile = await linuxSteam.protonProfile(gamePath);
    mapCatalog = new map_catalog_1.LocalMapCatalog();
    await (0, promises_1.writeFile)(configPath(), JSON.stringify({ gamePath }, null, 2), 'utf8');
    return inspected;
});
electron_1.ipcMain.handle('game:maps', async (event) => { trusted(event); if (!gamePath)
    throw new Error('Choose your game executable first.'); return mapCatalog.scan(gamePath); });
electron_1.ipcMain.handle('game:map-preview', async (event, id) => { trusted(event); if (typeof id !== 'string' || id.length > 240)
    throw new Error('Invalid map identifier.'); return mapCatalog.preview(id); });
const { HudPreferences } = require('./hud-preferences');
const windowsHudPreferences = new HudPreferences([
    node_path_1.default.join(process.env.LOCALAPPDATA || node_path_1.default.join(electron_1.app.getPath('home'),'AppData','Local'), 'Gas Powered Games','Supreme Commander 2','Game.prefs'),
    node_path_1.default.join(electron_1.app.getPath('documents'),'My Games','Gas Powered Games','Supreme Commander 2','Game.prefs'),
], () => launching || gameProcessId !== null);
const protonHudPreferences = new HudPreferences(() => protonProfile?.preferences ?? [], () => launching || gameProcessId !== null);
electron_1.ipcMain.handle('hud:load', async event => {
    trusted(event);
    if (linuxSteam) protonProfile = await linuxSteam.protonProfile(gamePath);
    return (linuxSteam ? protonHudPreferences : windowsHudPreferences).load();
});
electron_1.ipcMain.handle('hud:save', async (event, value) => {
    trusted(event);
    if (process.platform==='win32') {
        const {promisify}=require('node:util');
        const result=await promisify(require('node:child_process').execFile)(node_path_1.default.join(process.env.SystemRoot||'C:\\Windows','System32','tasklist.exe'),['/FI','IMAGENAME eq SupremeCommander2*','/FO','CSV','/NH'],{windowsHide:true,timeout:5000,maxBuffer:1024*1024});
        if (/^"SupremeCommander2[^"]*"/im.test(result.stdout)) throw Error('Close Supreme Commander 2 before saving HUD preferences here.');
    }
    if (linuxSteam) {
        if (await linuxSteam.gameIsRunning()) throw Error('Close Supreme Commander 2 before saving HUD preferences here.');
        protonProfile = await linuxSteam.protonProfile(gamePath);
    }
    return (linuxSteam ? protonHudPreferences : windowsHudPreferences).save(value);
});
electron_1.ipcMain.handle('community:open', async (event, channel) => {
    trusted(event);
    const links = require('../shared/model').COMMUNITY_LINKS;
    if (typeof channel !== 'string' || !Object.hasOwn(links, channel))
        throw Error('Unknown community link.');
    await electron_1.shell.openExternal(links[channel]);
});
electron_1.ipcMain.handle('support:open', async event => { trusted(event);await electron_1.shell.openExternal(require('../shared/model').SUPPORT_URL); });
electron_1.ipcMain.handle('game:inspect', async (event) => {
    trusted(event);
    if (!gamePath)
        return null;
    return (0, adapter_1.inspectExecutable)(gamePath);
});
async function launchGame(mode, lobbyId, roomInput) {
    if (process.platform !== 'win32' && !linuxSteam)
        throw new Error('Game launch requires Windows or the Linux Steam client.');
    if (linuxSteam && !['stock', 'reforged', 'replay', 'join'].includes(mode))
        throw new Error('The Linux preview supports skirmish, replays and direct Steam lobby joining.');
    if (!gamePath)
        throw new Error('Choose your SupCom 2 executable first.');
    if (launching || firewallBusy)
        throw new Error('Close the game or finish firewall setup before launching.');
    launching = true;
    let attempt = null;
    try {
        lastLogPath = null;
        attempt = await launch_attempt_1.LaunchAttempt.begin(logsPath(), mode);
        const preparation = { onProgress: (stage, detail) => attempt.record(stage, detail) };
        lastAttemptLog = attempt.file;
        currentAttempt = attempt;
        await attempt.record('checking-game');
        const selectedPath = gamePath;
        const inspected = await (0, adapter_1.inspectExecutable)(selectedPath);
        await attempt.record('checking-processes');
        if (linuxSteam) {
            if (await linuxSteam.gameIsRunning()) throw Error('Close Supreme Commander 2 before launching from Reforged.');
            protonProfile = await linuxSteam.protonProfile(selectedPath);
            const display = electron_1.screen.getPrimaryDisplay();
            const { hudScaleForResolution } = require('./hud-display');
            const resolution = mode === 'stock' ? null : (await protonHudPreferences.load().catch(() => null))?.resolution;
            preparation.hudScale = hudScaleForResolution(...(resolution ?? [display.size.width * display.scaleFactor, display.size.height * display.scaleFactor]));
        } else await (0, native_host_1.launchPreflight)();
        nativeGuestMessage = '';
        relayLog = null;
        lastRelayLog = '';
        lobbyMaps.stop();
        nativeRelay.stop();
        await shares.stop();
        await nativeRoom.stop();
        nativeObservation = new native_room_1.NativeLobbyObservation();
        lobbyMaps = new lobby_map_1.LobbyMapPublisher(id => mapCatalog.metadata(id));
        udpListenerAt = 0;
        monitor?.stop();
        monitor = null;
        tracker = null;
        mapTracker = null;
        udpProbePid = null;
        async function useRoomGameplay(context,room){
            if(!room?.gameplay)throw Error('This room has no selected gameplay patch. Recreate it with the updated client.');
            const patch=await require('./research-rules').fetchGameplayPatch(context,room.gameplay.id);
            preparation.gameplay=require('../server/gameplay').verifyPatch(patch);
            if(preparation.gameplay.profileId!==room.gameplay.profileId)throw Error('Room gameplay identity changed.');
            preparation.researchRuleset=preparation.gameplay.research;
        }
        async function confirmPrepared(prepared){if(preparation.gameplay){const proof=prepared.gameplayProof;if(!proof||proof.profileId!==preparation.gameplay.profileId||proof.patchId!==preparation.gameplay.id)throw Error('Prepared game ruleset differs from the selected patch.');await (0,room_share_1.roomApi)((0,room_share_1.validateHostRoom)(roomInput),'gameplay/ready',{gameplayId:preparation.gameplay.id,simulationHash:proof.simulationHash});}}
        let replayRoster = [];
        let replayRosterLocked = false;
        let savedReplayFile;
        let args = [], executable = selectedPath;
        let logPath;
        let readerLog;
        let rankedMatchId;
        let playRunId;
        let resultName;
        let relaySession;
        if (mode === 'relay-guest') {
            await attempt.record('checking-host-room');
            const context = (0, room_share_1.validateHostRoom)(roomInput), state = await (0, room_share_1.roomApi)(context, 'state'), room = state.room;
            if (state.protocol !== model_1.PROTOCOL || !room || room.id !== context.roomId || room.hostId === state.playerId || !room.nativeHost || room.nativeHost.phase !== 'lobby-observed' || room.steamLink)
                throw Error('Join the host’s independent Reforged lobby first.');
            preparation.rankedMatch = !!room.matchmakingId;
            const runId = room.nativeHost.id;
            playRunId = runId;
            rankedMatchId = room.matchmakingId;
            resultName = room.players.find(p => p.id === state.playerId)?.name;
            await attempt.record('preparing-map-download');
            await ensureInstalledMap(context, room.map, selectedPath);
            const fresh = await (0, room_share_1.roomApi)(context, 'state');
            if (fresh.room?.nativeHost?.id !== runId || fresh.room?.map?.id !== room.map?.id || fresh.room?.map?.metadataHash !== room.map?.metadataHash)
                throw Error('The host changed the map while preparing. Join again for the current map.');
            relaySession = { roomId: room.id, runId, role: 'guest' };
            await attempt.record('preparing-guest-game');
            await useRoomGameplay(context,room);
            const prepared = await (0, native_host_1.prepareNativeHost)(selectedPath, nativeAssets(), logsPath(), undefined, true, true, '127.16.0.1', false, room.name, true, room.players.find(p => p.id === state.playerId), false, preparation);
            await confirmPrepared(prepared);
            await attempt.record('connecting-guest-relay', 'Game diagnostic folder: ' + prepared.run);
            await nativeRelay.start(context, runId, 'guest', stage => attempt.record(stage));
            relayLog = node_path_1.default.join(prepared.run, 'relay-status.jsonl');
            await attempt.record('guest-relay-connected');
            executable = prepared.candidatePath;
            logPath = prepared.gameLog;
            readerLog = node_path_1.default.join(prepared.run, 'live-lobby-observations.jsonl');
            tracker = new live_lobby_1.LiveLobbyTracker();
            args = (0, adapter_1.steamLaunchArguments)(inspected.profile, logPath);
        }
        else if (mode === 'native-guest') {
            const approved = await (0, native_guest_1.authorizeNativeGuestProbe)(roomInput);
            const guestState = await (0, room_share_1.roomApi)(approved.context, 'state');
            await ensureInstalledMap(approved.context, guestState.room?.map, selectedPath);
            await useRoomGameplay(approved.context,(await (0,room_share_1.roomApi)(approved.context,'state')).room);
            const prepared = await (0, native_host_1.prepareNativeHost)(selectedPath, nativeAssets(), logsPath(), undefined, true, true, approved.address, false, approved.roomName, false, undefined, false, preparation);
            await confirmPrepared(prepared);
            await attempt.record('guest-game-prepared', 'Game diagnostic folder: ' + prepared.run);
            await (0, native_guest_1.authorizeNativeGuestProbe)(roomInput);
            const latestMap = (await (0, room_share_1.roomApi)(approved.context, 'state')).room?.map;
            if (latestMap?.id !== guestState.room?.map?.id || latestMap?.metadataHash !== guestState.room?.map?.metadataHash)
                throw Error('The host changed the map while preparing. Join again for the current map.');
            executable = prepared.candidatePath;
            logPath = prepared.gameLog;
            readerLog = node_path_1.default.join(prepared.run, 'live-lobby-observations.jsonl');
            tracker = new live_lobby_1.LiveLobbyTracker();
            args = (0, adapter_1.steamLaunchArguments)(inspected.profile, logPath);
        }
        else if (mode === 'host' || mode === 'lan-test' || mode === 'native-host' || mode === 'relay-host') {
            let requestedMap, requestedTitle, requestedPreferences;
            if (mode === 'host' || mode === 'native-host' || mode === 'relay-host') {
                const context = (0, room_share_1.validateHostRoom)(roomInput);
                await attempt.record('checking-host-room');
                // Authorize room ownership before building or spawning a host candidate.
                const roomState = await (0, room_share_1.roomApi)(context, 'state');
                if (!(0, room_share_1.ownsRoom)(roomState, context))
                    throw Error('Only the current room host can launch this game.');
                await useRoomGameplay(context,roomState.room);
                preparation.rankedMatch = !!roomState.room.matchmakingId;
                resultName = roomState.room.players.find(p => p.id === roomState.playerId)?.name;
                rankedMatchId = roomState.room.matchmakingId;
                requestedTitle = roomState.room.name;
                requestedPreferences = roomState.room.players.find(p => p.id === roomState.playerId);
                if (roomState.room.map) {
                    await attempt.record('checking-host-map');
                    await ensureInstalledMap(context, roomState.room.map, selectedPath);
                }
                const catalog = await mapCatalog.scan(selectedPath);
                const hostingMaps = new Map(catalog.maps.map(m => [m.id.toLowerCase(), mapCatalog.metadata(m.id)]));
                lobbyMaps.stop();
                lobbyMaps = new lobby_map_1.LobbyMapPublisher(id => hostingMaps.get(id) ?? null);
                if (roomState.room.map) {
                    const requested = roomState.room.map;
                    if (!requested)
                        throw new Error('Select an installed map before enabling the map handoff test.');
                    if (!catalog.maps.some(m => m.id.toLowerCase() === requested.id.toLowerCase() && m.metadataHash === requested.metadataHash))
                        throw new Error('The requested map is missing or changed in this game copy. Rescan maps and create the listing again.');
                    requestedMap = requested.id;
                    mapTracker = new map_handoff_1.MapHandoffTracker(requestedMap);
                }
            }
            await attempt.record('preparing-host-game');
            const prepare = () => (0, native_host_1.prepareNativeHost)(selectedPath, nativeAssets(), logsPath(), requestedMap, mode === 'lan-test' || mode === 'native-host' || mode === 'relay-host', true, undefined, false, requestedTitle, mode === 'relay-host', requestedPreferences, false, preparation);
            const prepared = mode === 'lan-test' ? await prepare() : await (0, host_preparation_1.withRoomHeartbeat)((0, room_share_1.validateHostRoom)(roomInput), prepare);
            await confirmPrepared(prepared);
            await attempt.record('host-game-prepared', 'Game diagnostic folder: ' + prepared.run);
            if (mode === 'relay-host')
                relayLog = node_path_1.default.join(prepared.run, 'relay-status.jsonl');
            // Start short-lived publication/relay leases after expensive preparation.
            // The reader will advertise readiness only after actual host observations.
            if (mode === 'host' || mode === 'native-host' || mode === 'relay-host') {
                const context = (0, room_share_1.validateHostRoom)(roomInput);
                const state = mode === 'host' ? await shares.begin(context) : await nativeRoom.begin(context);
                playRunId = state.room?.nativeHost?.id;
                if (mode === 'relay-host') {
                    await attempt.record('connecting-host-relay');
                    await nativeRelay.start(context, state.room.nativeHost.id, 'host', stage => attempt.record(stage));
                    relaySession = { roomId: context.roomId, runId: state.room.nativeHost.id, role: 'host' };
                }
            }
            executable = prepared.candidatePath;
            logPath = prepared.gameLog;
            if (mode === 'lan-test' || mode === 'native-host' || mode === 'relay-host') {
                udpRun = prepared.run;
                lastUdpObservation = '';
            }
            readerLog = node_path_1.default.join(prepared.run, 'live-lobby-observations.jsonl');
            args = (0, adapter_1.steamLaunchArguments)(inspected.profile, logPath);
            tracker = new live_lobby_1.LiveLobbyTracker();
        }
        else if (mode === 'join') {
            (0, adapter_1.validateLobbyId)(lobbyId);
            const title = roomInput === undefined ? undefined : await (0, room_share_1.joinedRoomTitle)(roomInput, lobbyId);
            const joined = roomInput === undefined ? null : await (0, room_share_1.roomApi)((0, room_share_1.validateHostRoom)(roomInput), 'state');
            if (joined)
                await ensureInstalledMap((0, room_share_1.validateHostRoom)(roomInput), joined.room?.map, selectedPath);
            preparation.rankedMatch = !!joined?.room?.matchmakingId;
            if (joined)
                await useRoomGameplay((0,room_share_1.validateHostRoom)(roomInput),joined.room);
            const prepared = await (0, native_host_1.prepareNativeHost)(selectedPath, nativeAssets(), logsPath(), undefined, false, true, undefined, true, title, false, joined?.room?.players.find(p => p.id === joined.playerId), false, preparation);
            await confirmPrepared(prepared);
            await attempt.record('steam-guest-game-prepared', 'Game diagnostic folder: ' + prepared.run);
            executable = prepared.candidatePath;
            logPath = prepared.gameLog;
            readerLog = node_path_1.default.join(prepared.run, 'live-lobby-observations.jsonl');
            tracker = new live_lobby_1.LiveLobbyTracker();
            args = (0, adapter_1.steamLaunchArguments)(inspected.profile, logPath, lobbyId);
        }
        else if (mode === 'reforged') {
            preparation.gameplay = require('../server/gameplay').patchFor('reforged-balance', '1.0.0', undefined, undefined, 'evidence-ai-5');
            await attempt.record('preparing-skirmish-game');
            const prepared = await (0, native_host_1.prepareNativeHost)(selectedPath, nativeAssets(), logsPath(), undefined, false, true, undefined, true, undefined, false, undefined, false, preparation);
            if (prepared.gameplayProof?.patchId !== preparation.gameplay.id)
                throw Error('Prepared skirmish ruleset differs from Reforged Balance.');
            executable = prepared.candidatePath;
            logPath = prepared.gameLog;
            args = (0, adapter_1.steamLaunchArguments)(inspected.profile, logPath);
        }
        else if (mode === 'replay') {
            const input = roomInput;
            const replayFile = await replayCatalog.resolve(input?.replayId);
            const playback = input?.playback === undefined ? await (0, replay_provenance_2.detectReplayPlayback)(replayFile) : (0, replay_playback_1.replayPlayback)(input.playback);
            if (playback === 'reforged') {
                const metadata = await (0, replay_provenance_2.readReplayMetadata)(replayFile);
                preparation.gameplay = metadata?.gameplay;
                preparation.replayPlayers = metadata?.players;
                preparation.researchRuleset = preparation.gameplay?.research??await (0, replay_provenance_1.readReplayResearch)(replayFile);
                preparation.replayRevision = (0, replay_version_1.replayRevision)(await (0, replay_provenance_1.readReplayVersion)(replayFile));
            }
            await attempt.record('preparing-replay-game', 'Playback: ' + playback);
            const prepared = await (0, replay_playback_1.prepareReplayPlayback)(inspected, nativeAssets(), logsPath(), replayFile, playback, undefined, preparation);
            await attempt.record('replay-game-prepared', 'Game diagnostic folder: ' + node_path_1.default.dirname(prepared.logPath));
            executable = prepared.executable;
            logPath = prepared.logPath;
            args = prepared.args;
        }
        else if (mode !== 'stock') {
            logPath = node_path_1.default.join(logsPath(), `supcom2-${mode}-${Date.now()}-${(0, node_crypto_1.randomUUID)()}.sclog`);
            args = (0, adapter_1.steamLaunchArguments)(inspected.profile, logPath, undefined);
            await (0, promises_1.mkdir)(logsPath(), { recursive: true });
        }
        if (['host', 'join', 'native-host', 'native-guest', 'relay-host', 'relay-guest'].includes(mode) && logPath) {
            savedReplayFile = node_path_1.default.join(node_path_1.default.dirname(logPath), 'match.SC2Replay');
            args.push('/savereplay', savedReplayFile);
        }
        // Keep normal movie handling: /nomovie stalled the otherwise unchanged baseline.
        const services = roomInput && typeof roomInput === 'object' && 'roomId' in roomInput && logPath ? new lobby_services_1.LobbyServices((0, room_share_1.validateHostRoom)(roomInput), node_path_1.default.join(node_path_1.default.dirname(logPath), 'lobby-services.bin'), Date.now, s => s.room?.nativeHost ? lobbyMaps.publish((0, room_share_1.validateHostRoom)(roomInput), s.room.nativeHost.id, s) : Promise.resolve()) : null;
        if (relaySession && logPath)
            await (0, promises_1.writeFile)(node_path_1.default.join(node_path_1.default.dirname(logPath), 'relay-session.json'), JSON.stringify({ format: 's2r-relay-session-v1', clientVersion: model_1.CLIENT_VERSION, at: new Date().toISOString(), ...relaySession }, null, 2));
        await attempt.record('launching-game', node_path_1.default.basename(executable));
        const gameStartedAt = Date.now();
        if (process.platform === 'win32' && node_path_1.default.basename(executable) === 'SupremeCommander2.ReforgedLobby.exe') {
            await attempt.record('preparing-firewall', 'Checking saved game access for the active network.');
            try {
                const { ensureGameFirewall } = await Promise.resolve().then(() => __importStar(require('./game-firewall')));
                const result = await ensureGameFirewall(nativeAssets(), executable);
                await attempt.record(result.needsSetup ? 'firewall-attention' : 'firewall-ready', result.message);
                if (logPath)
                    await (0, promises_1.writeFile)(node_path_1.default.join(node_path_1.default.dirname(logPath), 'firewall-before-launch.json'), JSON.stringify({ at: new Date().toISOString(), clientVersion: model_1.CLIENT_VERSION, automatic: true, operation: 'check-only', ...result }, null, 2));
            }
            catch (e) {
                await attempt.record('firewall-attention', e.message);
            }
        }
        const child = linuxSteam ? linuxSteam.launchThroughSteam({ original: selectedPath, executable, args,
            mailbox: steamMailbox(), openSteam: url => electron_1.shell.openExternal(url) })
            : (0, node_child_process_1.spawn)(executable, args, { cwd: node_path_1.default.dirname(executable), shell: false, detached: true, stdio: 'ignore' });
        const resultId = rankedMatchId ?? relaySession?.runId;
        const resultReporter = resultId && logPath && resultName ? new ranked_results_1.RankedResultReporter((0, room_share_1.validateHostRoom)(roomInput), resultId, logPath, node_path_1.default.join(node_path_1.default.dirname(logPath), 'ranked-result.json'), resultName, rankedMatchId ? 'matchmaking/report' : 'custom/report') : null;
        resultReporter?.start();
        const playMatch = rankedMatchId ?? playRunId;
        const playtime = playMatch && logPath && resultName && roomInput && 'roomId' in roomInput
            ? new PlaytimeReporter((0, room_share_1.validateHostRoom)(roomInput), playMatch, logPath, resultName) : null;
        playtime?.start();
        child.once('exit', (code, signal) => {
            if (gameProcessId === child.pid)
                gameProcessId = null;
            const windowsExitStatus = !linuxSteam && code !== null ? '0x' + (code >>> 0).toString(16).padStart(8, '0') : null;
            void attempt?.record('game-closed', (linuxSteam ? 'Steam launch exit status: ' : 'Windows exit status: ') + (windowsExitStatus ?? code ?? 'unavailable')).catch(() => { });
            if (logPath)
                void (0, promises_1.writeFile)(node_path_1.default.join(node_path_1.default.dirname(logPath), 'process-exit.json'), JSON.stringify({ at: new Date().toISOString(), exitCode: code, windowsExitStatus, signal }, null, 2)).catch(() => { });
            if (!linuxSteam && logPath && child.pid && code !== null && code !== 0) {
                const run = node_path_1.default.dirname(logPath), capture = (0, windows_crash_1.captureWindowsCrash)(child.pid, executable, gameStartedAt, nativeAssets(), run).catch(() => { });
                crashCaptures.set(run, capture);
                void capture.finally(() => { if (crashCaptures.get(run) === capture)
                    crashCaptures.delete(run); });
            }
            if (!linuxSteam && logPath && node_path_1.default.basename(executable) === 'SupremeCommander2.ReforgedLobby.exe')
                void Promise.resolve().then(() => __importStar(require('./game-firewall'))).then(async ({ gameFirewall }) => { const result = await gameFirewall(nativeAssets(), executable, false, false); await (0, promises_1.writeFile)(node_path_1.default.join(node_path_1.default.dirname(logPath), 'firewall-after-exit.json'), JSON.stringify({ at: new Date().toISOString(), clientVersion: model_1.CLIENT_VERSION, ...result }, null, 2)); }).catch(() => { });
            if (savedReplayFile)
                void (0, replay_provenance_2.finishSavedReplay)(savedReplayFile, (0, replay_provenance_2.snapshotReplayPlayers)(replayRoster, services?.scoreboard), model_1.CLIENT_VERSION, new Date(), preparation.researchRuleset,preparation.gameplay).catch(error => { if(code!==null&&code!==0&&error?.code==='ENOENT')return;void attempt?.record('replay-naming-unavailable', error instanceof Error ? error.message : String(error)).catch(() => { }); });
            services?.stop();
            lobbyMaps.stop();
            launching = false;
            udpProbePid = null;
            if (roomInput && typeof roomInput === 'object' && 'roomId' in roomInput) {
                const c = roomInput;
                void (async () => { await playtime?.finish(); await (0, ranked_results_1.finishReportedGame)(c, resultReporter); })().catch(() => { });
            }
            monitor?.stop();
            monitor = null;
            if (['host', 'native-host', 'native-guest', 'lan-test', 'join', 'relay-host', 'relay-guest', 'replay'].includes(mode) && win && !win.isDestroyed()) {
                if (win.isMinimized())
                    win.restore();
                win.show();
                win.focus();
            }
            nativeRelay.stop('Game process closed; independent relay stopped.');
            void shares.stop('Game process closed; automatic link removed.');
            void nativeRoom.stop('Game process closed; native host run removed.');
        });
        await new Promise((resolve, reject) => {
            child.once('spawn', () => { gameProcessId = child.pid ?? null; resolve(); });
            child.once('error', error => { services?.stop(); launching = false; reject(error); });
        });
        await attempt.record('game-running', 'Process ID: ' + child.pid);
        lastLogPath = logPath ?? null;
        if (mode === 'lan-test' || mode === 'native-host' || mode === 'relay-host')
            udpProbePid = child.pid ?? null;
        if (!linuxSteam && ['host', 'join', 'native-host', 'native-guest', 'lan-test', 'relay-host', 'relay-guest'].includes(mode) && tracker && child.pid && readerLog)
            monitor = (0, native_host_1.watchGameLobby)(child.pid, nativeAssets(), readerLog, tracker, mapTracker ?? undefined, sample => {
                const roster = (0, replay_provenance_2.replayPlayers)(sample);
                if (!replayRosterLocked && roster.length)
                    replayRoster = roster;
                if (replayRoster.length && sample.nativeLaunchState?.slice(0, 2).includes(1))
                    replayRosterLocked = true;
                lobbyMaps.ingest(sample); void services?.tick(sample); if (mode !== 'host')
                nativeObservation.ingest(sample); const r = sample; if (r.guestProbeReadOK === true)
                nativeGuestMessage = `Native guest phase ${r.guestProbePhase}; request ${r.guestJoinRequest}; callback ${r.guestJoinCallback}; error ${r.guestJoinError}. ${r.visible === true && r.isHost === false ? 'Guest lobby observed.' : 'Confirm game entry on screen.'}`; });
        child.unref();
        return { message: mode === 'reforged' ? 'Reforged started through Steam. Open Skirmish in SupCom 2 to play Reforged Balance.' : mode === 'replay' ? 'Supreme Commander 2 replay launch requested. Confirm playback in the game.' : mode === 'relay-host' || mode === 'relay-guest' ? 'Started independent multiplayer through Reforged.' : mode === 'native-guest' ? 'Started a private native UDP guest connection probe. Confirm entry in the host’s actual game lobby; handshake compatibility, completed matches and game admission are not verified yet.' : mode === 'native-host' ? 'Started the Reforged native host test with the redesigned lobby test. Its status is tracked by your Reforged room; the private guest probe is unverified and public native joining is not enabled.' : mode === 'lan-test' ? 'Started an isolated native UDP test with the redesigned Reforged lobby test. This is not authenticated multiplayer and is not shared in Reforged. Check the visible game lobby and UDP listener status in your profile.' : mode === 'host'
                ? mapTracker ? 'Started the redesigned lobby with map handoff using your installed game data. Wait for map readback and confirm the visible map inside SupCom 2.' : 'Started the redesigned lobby using your installed game data. Reforged will share the current lobby ID after live detection. Check the map inside SupCom 2.'
                : mode === 'stock' ? 'Started SupCom 2 normally. Room settings are not applied.'
                    : mode === 'join' ? `Started SupCom 2 with a join request for Steam lobby ${lobbyId}. Check the game to confirm entry.`
                        : 'Started SupCom 2 with logging. Create or join inside the game.' };
    }
    catch (error) {
        lobbyMaps.stop();
        await attempt?.record('failed', error instanceof Error ? error.message : String(error)).catch(() => { });
        if (roomInput && typeof roomInput === 'object' && 'roomId' in roomInput) {
            const c = roomInput;
            await (0, room_share_1.roomApi)(c, 'game-closed', { roomId: c.roomId }).catch(() => { });
        }
        nativeRelay.stop();
        launching = false;
        monitor?.stop();
        monitor = null;
        tracker = null;
        mapTracker = null;
        await shares.stop('Hosting did not start.');
        await nativeRoom.stop('Native hosting did not start.');
        throw error;
    }
}
electron_1.ipcMain.handle('replay:scan', async (e) => {
    trusted(e);
    if (linuxSteam) protonProfile = await linuxSteam.protonProfile(gamePath);
    return replayCatalog.scan(extraReplayFolder);
});
electron_1.ipcMain.handle('replay:scan-report', async (e) => { trusted(e); return replayCatalog.report(); });
electron_1.ipcMain.handle('replay:folder', async (e) => { trusted(e); return extraReplayFolder ?? null; });
electron_1.ipcMain.handle('replay:choose-folder', async (e) => { trusted(e); const chosen = await electron_1.dialog.showOpenDialog(win, { title: 'Select your Supreme Commander 2 replay folder', properties: ['openDirectory'] }); if (chosen.canceled)
    return null; extraReplayFolder = await replayFolderStore().save(chosen.filePaths[0]); return replayCatalog.scan(extraReplayFolder); });
electron_1.ipcMain.handle('replay:play', async (e, id, playback) => { trusted(e); return launchGame('replay', undefined, { replayId: id, ...(playback === undefined ? {} : { playback: (0, replay_playback_1.replayPlayback)(playback) }) }); });
electron_1.ipcMain.handle('replay:publish', async (e, value) => { trusted(e); if (!value || typeof value !== 'object')
    throw Error('Choose a replay first.'); return replayCatalog.publish(value.id, value.server, value.token); });
electron_1.ipcMain.handle('replay:download', async (e, value) => { trusted(e); if (!value || typeof value !== 'object')
    throw Error('Choose a community replay first.'); return replayCatalog.download(value.id, value.server, value.token, replayDirectory()); });
electron_1.ipcMain.handle('game:host-independent', async (event, input) => { trusted(event); return launchGame('relay-host', undefined, input); });
electron_1.ipcMain.handle('game:join-independent', async (event, input) => { trusted(event); return launchGame('relay-guest', undefined, input); });
electron_1.ipcMain.handle('game:host-room', async (event, input) => { trusted(event); return launchGame('host', undefined, input); });
electron_1.ipcMain.handle('game:stop-sharing', async (event) => { trusted(event); lobbyMaps.stop(); nativeRelay.stop(); await shares.stop(); await nativeRoom.stop(); });
electron_1.ipcMain.handle('game:join-native-probe', async (event, input) => { trusted(event); return launchGame('native-guest', undefined, input); });
electron_1.ipcMain.handle('game:host-native-test', async (event, input) => { trusted(event); return launchGame('native-host', undefined, input); });
electron_1.ipcMain.handle('game:restore-lobby', async (e) => { trusted(e); if (linuxSteam) throw Error('Windows lobby restoration is unavailable in the Linux preview.'); if (launching)
    throw Error('Close SupCom 2 before restoring the lobby.'); if (!gamePath)
    throw Error('Select your prepared test copy first.'); await (0, native_host_1.launchPreflight)(); const inspected = await (0, adapter_1.inspectExecutable)(gamePath); if (node_path_1.default.basename(inspected.path).toLowerCase() !== 'supremecommander2.exe' || node_path_1.default.basename(node_path_1.default.dirname(inspected.path)).toLowerCase() !== 'bin')
    throw Error('Select the original executable in your prepared copy.'); const prepared = await (0, steam_runtime_1.prepareSteamRuntime)(inspected.path, nativeAssets(), logsPath()); await (0, native_lobby_1.prepareLobbyAssets)(node_path_1.default.dirname(node_path_1.default.dirname(prepared)), nativeAssets(), false); return { message: 'Restored the previously working lobby scene in the prepared copy.' }; });
electron_1.ipcMain.handle('server:open-manager', async (e) => { trusted(e); await privateServer.stop(); const args = electron_1.app.isPackaged ? ['--s2r-server'] : [electron_1.app.getAppPath(), '--s2r-server']; const child = (0, node_child_process_1.spawn)(process.execPath, args, { detached: true, stdio: 'ignore', shell: false }); await new Promise((r, j) => { child.once('spawn', r); child.once('error', j); }); child.unref(); });
electron_1.ipcMain.handle('server:import-connection', async (e) => { trusted(e); const chosen = await electron_1.dialog.showOpenDialog(win, { title: 'Import Reforged server connection', properties: ['openFile'], filters: [{ name: 'Reforged server connection', extensions: ['json'] }] }); if (chosen.canceled)
    return null; const bytes = await (0, promises_1.readFile)(chosen.filePaths[0]); if (bytes.length > 2048)
    throw new Error('Server connection file is too large.'); return require('./server-invite').validateServerInvite(JSON.parse(bytes.toString('utf8'))); });
electron_1.ipcMain.handle('server:manager-connection', async (e) => {
    trusted(e);
    const { ServerSettingsStore } = await Promise.resolve().then(() => __importStar(require('./server-settings'))), { localServerInterfaces } = await Promise.resolve().then(() => __importStar(require('./private-server')));
    const settings = await new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json')).load();
    if (!localServerInterfaces().includes(settings.address))
        throw new Error('The saved server interface is disconnected. Open Server Manager and choose a connected interface.');
    const address = `http://${settings.address}:47820`;
    try {
        const r = await fetch(address + '/health', { signal: AbortSignal.timeout(2000) });
        const h = await r.json();
        if (!r.ok || h.kind !== 'private-test-lobby')
            throw new Error();
    }
    catch {
        throw new Error('Start the server in Server Manager first.');
    }
    return { running: true, address, accessKey: settings.accessKey };
});
electron_1.ipcMain.handle('game:launch-udp-test', async (e) => { trusted(e); return launchGame('lan-test'); });
electron_1.ipcMain.handle('game:udp-status', async (e) => {
    trusted(e);
    if (!udpProbePid || !launching)
        return { running: false, message: 'No native UDP test is running.' };
    const { execFile } = await Promise.resolve().then(() => __importStar(require('node:child_process'))), { promisify } = await Promise.resolve().then(() => __importStar(require('node:util'))), { powershellPath } = await Promise.resolve().then(() => __importStar(require('./native-host')));
    let stdout;
    try {
        ({ stdout } = await promisify(execFile)(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; @(Get-NetUDPEndpoint -OwningProcess ${udpProbePid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 6000, maxBuffer: 16384 }));
    }
    catch {
        return { running: true, message: 'Windows could not inspect the native UDP listener. Open the diagnostic logs and confirm the visible lobby before continuing.' };
    }
    const raw = stdout.trim() ? JSON.parse(stdout) : [], rows = Array.isArray(raw) ? raw : [raw], matches = rows.filter((r) => r.LocalPort === 16010);
    if (matches.length)
        udpListenerAt = Date.now();
    const result = { running: true, message: matches.length ? 'Native UDP port 16010 observed for the launched SupCom 2 process. Addresses: ' + matches.map((r) => r.LocalAddress).join(', ') + '. This confirms a listener, not a successful match or client-only access.' : 'No UDP 16010 listener observed yet. A visible lobby alone does not prove networking.' };
    if (udpRun && result.message !== lastUdpObservation) {
        lastUdpObservation = result.message;
        await (0, promises_1.writeFile)(node_path_1.default.join(udpRun, 'native-udp-status.json'), JSON.stringify({ at: new Date().toISOString(), pid: udpProbePid, endpoints: rows, ...result }, null, 2));
    }
    return result;
});
electron_1.ipcMain.handle('server:interfaces', async (event) => { trusted(event); const { localServerInterfaces } = await Promise.resolve().then(() => __importStar(require('./private-server'))); return localServerInterfaces(); });
electron_1.ipcMain.handle('server:start', async (event, address) => { trusted(event); return privateServer.start(address); });
electron_1.ipcMain.handle('server:stop', async (event) => { trusted(event); await shares.stop(); await privateServer.stop(); });
electron_1.ipcMain.handle('server:status', async (event) => { trusted(event); return privateServer.status(); });
electron_1.ipcMain.handle('server:import-admin', async (event) => {
    trusted(event);
    if (!privateServer.status().running)
        throw new Error('Start this PC’s room server first.');
    const result = await electron_1.dialog.showOpenDialog(win, { title: 'Import private administrator setup', properties: ['openFile'], filters: [{ name: 'S2R administrator setup', extensions: ['json'] }] });
    if (result.canceled)
        return { message: 'Administrator setup import cancelled.' };
    const file = result.filePaths[0];
    if ((await (0, promises_1.stat)(file)).size > 2048)
        throw new Error('Invalid administrator setup file.');
    await privateServer.importAdmin(JSON.parse(await (0, promises_1.readFile)(file, 'utf8')));
    return { message: 'Administrator PIN configured on this server. Sign in, open your profile and unlock Admin.' };
});
electron_1.ipcMain.handle('game:firewall', async (event, value) => {
    trusted(event);
    if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['setup', 'includePublic'].includes(k)) || typeof value.setup !== 'boolean' || typeof value.includePublic !== 'boolean')
        throw Error('Invalid firewall request.');
    if (launching || firewallBusy)
        throw Error('Close Supreme Commander 2 or finish the current firewall check first.');
    if (!gamePath)
        throw Error('Choose your game first.');
    firewallBusy = true;
    try {
        await (0, native_host_1.launchPreflight)();
        const { verifiedFirewallProgram, gameFirewall } = await Promise.resolve().then(() => __importStar(require('./game-firewall')));
        const runtime = await (0, steam_runtime_1.prepareSteamRuntime)(gamePath, nativeAssets(), logsPath());
        const result = await gameFirewall(nativeAssets(), await verifiedFirewallProgram(runtime), value.setup, value.includePublic);
        await (0, promises_1.mkdir)(logsPath(), { recursive: true });
        await (0, promises_1.writeFile)(node_path_1.default.join(logsPath(), 'firewall-check-latest.json'), JSON.stringify({ at: new Date().toISOString(), clientVersion: model_1.CLIENT_VERSION, setup: value.setup, ...result }, null, 2));
        return { message: result.message };
    }
    finally {
        firewallBusy = false;
    }
});
electron_1.ipcMain.handle('game:launch-stock', async (event) => { trusted(event); return launchGame('stock'); });
electron_1.ipcMain.handle('game:launch-diagnostic', async (event) => { trusted(event); return launchGame(linuxSteam ? 'reforged' : 'diagnostic'); });
electron_1.ipcMain.handle('game:join-steam', async (event, lobbyId, context) => { trusted(event); (0, adapter_1.validateLobbyId)(lobbyId); return launchGame('join', lobbyId, context); });
electron_1.ipcMain.handle('game:open-logs', async (event) => {
    trusted(event);
    await (0, promises_1.mkdir)(logsPath(), { recursive: true });
    const error = await electron_1.shell.openPath(logsPath());
    if (error)
        throw new Error(error);
});
electron_1.ipcMain.handle('game:export-logs', async (event) => {
    trusted(event);
    if (lastLogPath)
        await crashCaptures.get(node_path_1.default.dirname(lastLogPath));
    const { gameDiagnostics } = await Promise.resolve().then(() => __importStar(require('./game-diagnostics')));
    const bundle = await gameDiagnostics(logsPath(), lastLogPath, lastAttemptLog);
    const selected = await electron_1.dialog.showSaveDialog(win, { title: 'Export latest launch diagnostics', defaultPath: bundle.name, filters: [{ name: 'Launch diagnostics', extensions: ['zip'] }] });
    if (selected.canceled || !selected.filePath)
        return { message: 'Export cancelled.' };
    await (0, promises_1.writeFile)(selected.filePath, bundle.bytes);
    return { message: bundle.message };
});
electron_1.ipcMain.handle('game:inspect-log', async (event) => {
    trusted(event);
    const result = await electron_1.dialog.showOpenDialog(win, { title: 'Read a SupCom 2 game log', defaultPath: logsPath(), properties: ['openFile'], filters: [{ name: 'SupCom 2 game log', extensions: ['sclog'] }] });
    if (result.canceled)
        return null;
    const filePath = result.filePaths[0];
    if (node_path_1.default.extname(filePath).toLowerCase() !== '.sclog')
        throw new Error('Select a .sclog game log.');
    return { fileName: node_path_1.default.basename(filePath), report: await (0, logs_1.readGameLog)(filePath) };
});
electron_1.ipcMain.handle('game:launch-status', async (event) => {
    trusted(event);
    const status = { running: launching, ...(launching && !gameProcessId && currentAttempt ? { preparing: currentAttempt.progress() } : {}), logName: lastLogPath ? node_path_1.default.basename(lastLogPath) : lastAttemptLog ? node_path_1.default.basename(lastAttemptLog) : null,
        report: { lobbyId: null, state: 'no-session', message: lastAttemptLog ? 'Launch attempt recorded. Open the diagnostic log folder for its preparation and connection stages.' : 'No diagnostic launch in this client session.' } };
    if (lastLogPath) {
        try {
            status.report = await (0, logs_1.readGameLog)(lastLogPath);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            status.report.message = 'Waiting for the game to create its log. It may not have flushed yet.';
        }
    }
    if (tracker && !udpProbePid)
        status.live = tracker.get();
    if (mapTracker) {
        const handoff = mapTracker.get(), published = lobbyMaps.published();
        status.mapHandoff = published && published === lobbyMaps.current() && published !== handoff.requestedMap ? { ...handoff, state: 'updated', currentMap: published, message: 'Map changed in the game lobby. The client listing has been updated.' } : handoff;
    }
    status.relay = nativeRelay.status();
    if (nativeGuestMessage)
        status.nativeGuest = { message: nativeGuestMessage };
    const relayEntry = JSON.stringify({ relay: status.relay, guest: nativeGuestMessage });
    if (relayLog && relayEntry !== lastRelayLog) {
        lastRelayLog = relayEntry;
        await (0, promises_1.appendFile)(relayLog, JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(relayEntry) }) + '\n').catch(() => { });
    }
    status.sharing = shares.status();
    if (udpProbePid)
        status.nativeHost = nativeRoom.status();
    return status;
});
electron_1.ipcMain.handle('match:save', async (event, input) => {
    trusted(event);
    if (!input || typeof input !== 'object')
        throw new Error('Invalid manifest.');
    const manifest = input;
    const serialized = JSON.stringify(manifest, null, 2);
    if (serialized.length > 32_000 || manifest.protocol !== model_1.PROTOCOL || manifest.adapter !== 'not-implemented' || !Array.isArray(manifest.players))
        throw new Error('Invalid manifest.');
    const result = await electron_1.dialog.showSaveDialog(win, { title: 'Save configuration rehearsal', defaultPath: 'sc2-match.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath)
        return false;
    await (0, promises_1.writeFile)(result.filePath, serialized, 'utf8');
    return true;
});
async function createWindow() {
    const icon = electron_1.app.isPackaged ? node_path_1.default.join(process.resourcesPath, linuxSteam ? 'branding/icon.png' : 'branding/icon.ico') : node_path_1.default.resolve(__dirname, '../../../build/icon.ico');
    const area = electron_1.screen.getPrimaryDisplay().workArea, width = Math.min(1380, area.width), height = Math.min(960, area.height);
    win = new electron_1.BrowserWindow({ width, height, minWidth: Math.min(960, area.width), minHeight: Math.min(720, area.height), x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), backgroundColor: '#0a101b', title: 'Supreme Commander 2: Reforged',
        icon,
        webPreferences: { preload: node_path_1.default.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    if (process.platform === 'win32')
        win.setAppDetails({ appId: APP_ID, appIconPath: icon, appIconIndex: 0, relaunchCommand: electron_1.app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${electron_1.app.getAppPath()}"`, relaunchDisplayName: 'Supreme Commander 2: Reforged' });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.on('close', event => { if (publicSetupRunning)
        event.preventDefault(); });
    win.on('closed', () => { mapDownloadAbort?.abort(); win = null; });
    await win.loadFile(ui);
}
electron_1.app.whenReady().then(async () => {
    if (!serverLock) return;
    if (publicBoot) {
        if (!serverLock)
            return;
        const setup = publicSetup(), saved = await setup.configured();
        if (saved) {
            await setup.start(saved.domain);
            await setup.whenIdle();
        }
        electron_1.app.quit();
        return;
    }
    if (serverMode) {
        if (!serverLock)
            return;
        await require('./server-manager').startServerManager(accountDirectory());
        return;
    }
    try {
        const config = JSON.parse(await (0, promises_1.readFile)(configPath(), 'utf8'));
        if (typeof config.gamePath === 'string')
            gamePath = config.gamePath;
    }
    catch { /* First run or invalid config: ask user to select again. */ }
    if (linuxSteam) {
        if (!gamePath || !(0, steam_runtime_1.isSteamInstallation)(gamePath) || !(await (0, promises_1.stat)(gamePath).catch(() => null))?.isFile())
            gamePath = await linuxSteam.discoverSteamGame();
        protonProfile = await linuxSteam.protonProfile(gamePath);
    }
    try {
        extraReplayFolder = (await replayFolderStore().load()) ?? undefined;
    }
    catch { /* Keep local browsing available; choosing a folder replaces invalid preferences. */ }
    try {
        const { ServerSettingsStore } = await Promise.resolve().then(() => __importStar(require('./server-settings')));
        const settings = await new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json')).load();
        if (await new ServerSettingsStore(node_path_1.default.join(accountDirectory(), 'server-settings.json')).exists() && (settings.autoStart || settings.startOnClient !== false)) {
            const args = electron_1.app.isPackaged ? ['--s2r-server', '--background'] : [electron_1.app.getAppPath(), '--s2r-server', '--background'];
            const child = (0, node_child_process_1.spawn)(process.execPath, args, { detached: true, stdio: 'ignore', shell: false });
            child.once('error', () => { });
            child.unref();
        }
    }
    catch { /* Explicit manager startup reports configuration errors. */ }
    await createWindow();
    electron_1.app.on('activate', () => { if (!win)
        void createWindow(); });
}).catch(error => { electron_1.dialog.showErrorBox('SupCom 2: Reforged startup failed', error instanceof Error ? error.message : 'Could not start.'); electron_1.app.quit(); });
electron_1.app.on('window-all-closed', () => { if (!serverMode && process.platform !== 'darwin')
    electron_1.app.quit(); });
electron_1.app.on('before-quit', event => { if (publicSetupRunning) {
    event.preventDefault();
    return;
} monitor?.stop(); monitor = null; lobbyMaps.stop(); nativeRelay.stop(); void shares.stop(); void nativeRoom.stop(); void privateServer.stop(); });

// Explicit local administrator action; credentials are entered only in the visible local prompt.
electron_1.ipcMain.handle('server:configure-discord', async event => {trusted(event);return require('./discord-setup').openDiscordSetup(process.resourcesPath,electron_1.app.getPath('userData'));});
