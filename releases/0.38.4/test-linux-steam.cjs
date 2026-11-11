'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const path = require('node:path');
const steam = require('./app/dist/node/desktop/linux-steam');

async function test() {
    const root = await fs.mkdtemp(path.join(tmpdir(), 's2r-linux-'));
    const shell = path.join(__dirname, 'linux/steam-launch.sh');
    try {
        const steamRoot = path.join(root, '.local/share/Steam');
        const library = path.join(root, "Drive's Steam Library");
        const original = path.join(library, 'steamapps/common/Supreme Commander 2/bin/SupremeCommander2.exe');
        const executable = path.join(root, 'runtime/bin/SupremeCommander2.ReforgedLobby.exe');
        await fs.mkdir(path.dirname(original), { recursive: true });
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.mkdir(path.join(steamRoot, 'steamapps'), { recursive: true });
        await fs.writeFile(original, 'stock game fixture');
        await fs.writeFile(executable, 'patched game fixture');
        await fs.writeFile(path.join(steamRoot, 'steamapps/libraryfolders.vdf'), `"libraryfolders" { "1" { "path" "${library}" } }`);
        await fs.writeFile(path.join(library, 'steamapps/appmanifest_40100.acf'), '"AppState" { "appid" "40100" "installdir" "Supreme Commander 2" }');
        const user = path.join(library, 'steamapps/compatdata/40100/pfx/drive_c/users/steamuser');
        await fs.mkdir(user, { recursive: true });
        const previousHome = process.env.HOME;
        process.env.HOME = root;
        try { assert.equal(await steam.discoverSteamGame(), original); }
        finally { process.env.HOME = previousHome; }
        assert.equal((await steam.protonProfile(original, [])).prefix, path.join(user, '../../..'));
        assert.equal(await steam.findStockExecutable(path.dirname(original)), original);
        const proc = path.join(root, 'proc');
        await fs.mkdir(path.join(proc, '123'), { recursive: true });
        await fs.writeFile(path.join(proc, '123/comm'), 'SupremeCommande\n');
        assert.equal(await steam.gameIsRunning(proc), true);
        await fs.writeFile(path.join(proc, '123/comm'), 'other-game\n');
        assert.equal(await steam.gameIsRunning(proc), false);
        assert.equal(steam.winePath('/home/player/Game Data/file.SC2Replay'), 'Z:\\home\\player\\Game Data\\file.SC2Replay');
        assert.throws(() => steam.winePath('relative'), /Linux-compatible/);

        const mailbox = path.join(root, "Reforged's game launch");
        const argsRecord = path.join(root, 'proton-args.json');
        const emulator = path.join(root, 'fake-proton.cjs');
        await fs.writeFile(emulator, `const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(argsRecord)}, JSON.stringify([process.cwd(), ...process.argv.slice(2)]));
            process.exitCode = 17;`);
        function run(argv) {
            return spawn(shell, [mailbox, process.execPath, emulator, 'waitforexitandrun', ...argv],
                { cwd: path.dirname(original), stdio: 'ignore' });
        }
        assert.match(steam.steamLaunchOption(shell, mailbox), /'\\''/);
        assert.deepEqual(await once(run([original]), 'exit'), [17, null]);
        assert.deepEqual(JSON.parse(await fs.readFile(argsRecord, 'utf8')), [path.dirname(original), 'waitforexitandrun', original]);

        const replay = path.join(root, 'A replay.SC2Replay'), log = path.join(root, 'A log.sclog');
        const launch = steam.launchThroughSteam({ original, executable,
            args: ['+connect_lobby', '109775242860678901', '/log', log, '/replay', replay],
            mailbox, openSteam: async url => { assert.equal(url, 'steam://rungameid/40100'); run(['./SupremeCommander2.exe']); },
            timeout: 2500, poll: 10 });
        const exited = once(launch, 'exit');
        await once(launch, 'spawn');
        assert.ok(launch.pid > 0);
        assert.deepEqual(await exited, [17, null]);
        assert.deepEqual(JSON.parse(await fs.readFile(argsRecord, 'utf8')), [path.dirname(executable),
            'waitforexitandrun', executable, '+connect_lobby', '109775242860678901',
            '/log', steam.winePath(log), '/replay', steam.winePath(replay)]);
        assert.equal(await fs.readFile(original, 'utf8'), 'stock game fixture');

        const wrong = steam.launchThroughSteam({ original, executable, args: [], mailbox,
            openSteam: async () => { run(['/tmp/SupremeCommander2.exe']); }, timeout: 2500, poll: 10 });
        const [error] = await once(wrong, 'error');
        assert.match(error.message, /Steam did not supply the selected game executable/);
        const missed = steam.launchThroughSteam({ original, executable, args: [], mailbox,
            openSteam: async () => {}, timeout: 100, poll: 10 });
        const [timeout] = await once(missed, 'error');
        assert.match(timeout.message, /Steam did not start Reforged/);
        await fs.stat(path.join(mailbox, 'request')).then(() => assert.fail('Expired request remains'), e => assert.equal(e.code, 'ENOENT'));
        console.log('Verified Steam discovery, Proton profile paths, untouched stock launch, argv handoff, and launch failure cleanup.');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

test().catch(error => { console.error(error); process.exitCode = 1; });
