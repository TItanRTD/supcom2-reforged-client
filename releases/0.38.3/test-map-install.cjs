'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const app = path.resolve(process.argv[2] ?? path.join(__dirname, 'app'));
const { installMapPackage, ensureGameMap } = require(app + '/dist/node/desktop/map-install.js');
const { writeZip } = require('./payload/resources/native/lobby/supcom2-ui.cjs');

const hash = b => createHash('sha256').update(b).digest('hex');
const name = '_Map_2p_Reforged_Revel_Creek_v13.scd';
const mapPath = 'maps/S2R_AETHERMOOR/S2R_AETHERMOOR_scenario.lua';
const scenario = Buffer.from("ScenarioInfo = { name = 'Revel Creek', type = 'skirmish' }");
const map = { id: '/' + mapPath, metadataHash: hash(scenario) };
const archive = version => writeZip([
    { name: mapPath, data: scenario },
    { name: 'maps/S2R_AETHERMOOR/S2R_AETHERMOOR.scmap', data: Buffer.from('Terrain revision ' + version) },
]);
const v12 = archive(12), v13 = archive(13);
const packageInfo = { id: hash(v13), filename: name, size: v13.length };

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's2r-map-install-'));
    let downloads = 0, published = true;
    const server = createServer((req, res) => {
        if (req.url.startsWith('/api/maps/resolve?')) {
            if (published) res.end(JSON.stringify({ package: packageInfo }));
            else res.writeHead(404).end(JSON.stringify({ error: 'Unpublished' }));
        } else if (req.url === '/api/maps/download/' + packageInfo.id) {
            downloads++;
            res.writeHead(200, { 'Content-Length': v13.length });
            res.end(v13);
        } else res.writeHead(404).end();
    });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const gamedata = path.join(root, 'gamedata');
        await fs.mkdir(gamedata);
        const exe = path.join(root, 'bin', 'SupremeCommander2.exe'), cache = path.join(root, 'cache');
        const target = path.join(gamedata, name);
        const legacy = path.join(gamedata, '_reforged_map_' + packageInfo.id + '.scd');
        const old = path.join(gamedata, name.replace('_v13', '_v12'));
        const context = { server: 'http://127.0.0.1:' + server.address().port, token: 'a'.repeat(64) };
        const signal = new AbortController().signal;

        await fs.writeFile(legacy, v13);
        await ensureGameMap(context, map, exe, cache, signal);
        assert.deepEqual(await fs.readdir(gamedata), [name]);
        assert.deepEqual(await fs.readFile(target), v13);
        assert.equal(downloads, 0);

        await fs.writeFile(old, v12);
        await assert.rejects(ensureGameMap(context, map, exe, cache, signal), /v12\.scd contains another copy/);
        assert.deepEqual(await fs.readFile(old), v12);
        await fs.unlink(old);

        await fs.writeFile(target, v12);
        await assert.rejects(ensureGameMap(context, map, exe, cache, signal), /already exists with different contents/);
        assert.deepEqual(await fs.readFile(target), v12);
        await fs.unlink(target);

        await installMapPackage({ ...context, ...packageInfo }, exe, cache, signal);
        assert.deepEqual(await fs.readFile(target), v13);
        assert.equal(downloads, 1);
        await ensureGameMap(context, map, exe, cache, signal);
        assert.equal(downloads, 1);
        await assert.rejects(installMapPackage({ ...context, ...packageInfo, filename: 'CON.scd' }, exe, cache, signal), /on Windows/);

        await fs.unlink(target);
        await installMapPackage({ ...context, ...packageInfo, filename: name.replace('.scd', '.zip') }, exe, cache, signal);
        assert.deepEqual(await fs.readdir(gamedata), [name]);
        assert.equal(downloads, 1);

        published = false;
        await ensureGameMap(context, map, exe, cache, signal);
        console.log('Verified published filenames, legacy migration, byte-identical scenario collisions, and local map fallback.');
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
