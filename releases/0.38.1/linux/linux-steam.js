'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const APP_ID = '40100';
const STEAM_URL = 'steam://rungameid/' + APP_ID;
const STOCK = 'supremecommander2.exe';
const PATCHED = 'supremecommander2.reforgedlobby.exe';

async function readLimited(file, limit) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > limit) return '';
    return fs.readFile(file, 'utf8');
}

const vdfValues = (text, key) => [...text.matchAll(new RegExp('"'+key+'"\\s+"((?:\\\\.|[^"\\\\])*)"', 'gi'))]
    .map(match => match[1].replace(/\\(["\\])/g, '$1'));

async function steamLibraries(home = os.homedir(), dataHome = process.env.XDG_DATA_HOME) {
    const roots = [path.join(home, '.local/share/Steam'), path.join(home, '.steam/steam'), path.join(home, '.steam/root')];
    if (dataHome && path.isAbsolute(dataHome)) roots.unshift(path.join(dataHome, 'Steam'));
    const libraries = new Set();
    for (const root of roots) {
        const real = await fs.realpath(root).catch(() => null);
        if (!real || libraries.has(real)) continue;
        libraries.add(real);
        const vdf = await readLimited(path.join(real, 'steamapps/libraryfolders.vdf'), 1024 * 1024).catch(() => '');
        for (const library of vdfValues(vdf, 'path')) {
            if (!path.isAbsolute(library)) continue;
            const resolved = await fs.realpath(library).catch(() => null);
            if (resolved) libraries.add(resolved);
        }
    }
    return [...libraries];
}

async function findStockExecutable(bin) {
    const entries = await fs.readdir(bin, { withFileTypes: true }).catch(() => []);
    const matches = entries.filter(entry => entry.isFile() && entry.name.toLowerCase() === STOCK);
    return matches.length === 1 ? path.join(bin, matches[0].name) : null;
}

async function discoverSteamGame(libraries) {
    for (const library of libraries ?? await steamLibraries()) {
        const manifest = await readLimited(path.join(library, 'steamapps', 'appmanifest_' + APP_ID + '.acf'), 128 * 1024).catch(() => '');
        const [id] = vdfValues(manifest, 'appid');
        const [directory] = vdfValues(manifest, 'installdir');
        if (id !== APP_ID || !directory || directory === '.' || directory === '..' || /[/\\\\\x00-\x1f]/.test(directory)) continue;
        const exe = await findStockExecutable(path.join(library, 'steamapps', 'common', directory, 'bin'));
        if (exe) return exe;
    }
    return null;
}

async function protonProfile(executable, libraries) {
    if (!executable) return null;
    const library = path.resolve(path.dirname(executable), '../../../..');
    for (const root of new Set([library, ...(libraries ?? await steamLibraries())])) {
        const prefix = path.join(root, 'steamapps', 'compatdata', APP_ID, 'pfx');
        const user = path.join(prefix, 'drive_c', 'users', 'steamuser');
        const stat = await fs.stat(user).catch(() => null);
        if (!stat?.isDirectory()) continue;
        return {
            prefix,
            preferences: [path.join(user, 'AppData/Local/Gas Powered Games/Supreme Commander 2/Game.prefs'),
                path.join(user, 'Documents/My Games/Gas Powered Games/Supreme Commander 2/Game.prefs')],
            replays: [path.join(user, 'Documents/My Games/SquareEnix/Supreme Commander 2/replays'),
                path.join(user, 'Documents/My Games/Gas Powered Games/Supreme Commander 2')],
        };
    }
    return null;
}

async function gameIsRunning(proc = '/proc') {
    const entries = await fs.readdir(proc).catch(() => []);
    const pids = entries.filter(name => /^\d+$/.test(name));
    for (let start = 0; start < pids.length; start += 32) {
        const names = await Promise.all(pids.slice(start, start + 32).map(pid =>
            fs.readFile(path.join(proc, pid, 'comm'), 'utf8').catch(() => '')));
        if (names.some(name => /^supremecommande(?:r2(?:\.|$)|\s*$)/i.test(name.trim()))) return true;
    }
    return false;
}

function winePath(file) {
    if (!path.isAbsolute(file) || /[\\\\\x00-\x1f]/.test(file)) throw Error('Choose a game or replay path with Linux-compatible file names.');
    return 'Z:' + file.replaceAll('/', '\\');
}

function gameArguments(args) {
    const fileOptions = new Set(['/log', '/replay', '/savereplay']);
    return args.map((arg, i) => fileOptions.has(args[i - 1]) ? winePath(arg) : arg);
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function steamLaunchOption(wrapper, mailbox) {
    return quote(wrapper) + ' ' + quote(mailbox) + ' %command%';
}

async function writeAtomic(file, data) {
    const temp = file + '.tmp';
    try {
        await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
}

/** Present the Steam-managed game lifetime to the existing desktop launch flow. */
function launchThroughSteam({ original, executable, args, mailbox, openSteam, timeout = 45_000, poll = 250 }) {
    const child = new EventEmitter();
    child.unref = () => {};
    let status, acknowledged = false;
    const request = path.join(mailbox, 'request');
    const pending = async () => {
        if (path.basename(original).toLowerCase() !== STOCK ||
            ![STOCK, PATCHED].includes(path.basename(executable).toLowerCase())) throw Error('Invalid Steam game executable.');
        await fs.mkdir(mailbox, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(mailbox);
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077))
            throw Error('Reforged requires a private Steam launch folder.');
        status = await fs.mkdtemp(path.join(mailbox, 'launch-'));
        const expires = Date.now() + timeout;
        const fields = [String(Math.ceil(expires / 1000)), original, executable, status, ...gameArguments(args)];
        if (fields.some(value => value.includes('\0'))) throw Error('Invalid game launch arguments.');
        await writeAtomic(request, fields.join('\0') + '\0');
        await openSteam(STEAM_URL);
        while (true) {
            const error = await readLimited(path.join(status, 'error'), 2048).catch(() => '');
            if (error) throw Error(error.trim());
            const started = (await readLimited(path.join(status, 'started'), 128).catch(() => '')).trim();
            if (/^[1-9]\d{0,9}$/.test(started)) {
                child.pid = Number(started);
                acknowledged = true;
                child.emit('spawn');
                break;
            }
            if (Date.now() >= expires)
                throw Error('Steam did not start Reforged. Start SupCom 2 once in Steam with Proton, then copy the Reforged launch option into Steam’s game Properties.');
            await delay(poll);
        }
        while (true) {
            const exited = (await readLimited(path.join(status, 'exit'), 128).catch(() => '')).trim();
            if (/^\d{1,3}$/.test(exited)) return Number(exited);
            if (!(await fs.stat('/proc/' + child.pid).catch(() => null))) return null;
            await delay(Math.max(750, poll));
        }
    };
    const cleanup = async () => {
        if (!acknowledged && status) await fs.rm(request, { force: true }).catch(() => {});
        if (status) await fs.rm(status, { recursive: true, force: true }).catch(() => {});
    };
    void pending().then(async code => {
        await cleanup();
        child.emit('exit', code, null);
    }, async error => {
        await cleanup();
        if (acknowledged) child.emit('exit', null, null);
        else child.emit('error', error);
    });
    return child;
}

module.exports = { discoverSteamGame, findStockExecutable, protonProfile, gameIsRunning, winePath, steamLaunchOption, launchThroughSteam };
