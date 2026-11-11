'use strict';
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const native = path.resolve(process.env.NATIVE_ASSETS || path.join(__dirname, 'payload/resources/native'));
const app = path.resolve(process.env.PACKAGED_APP || path.join(__dirname, 'app'));
const retail = path.resolve(process.env.RETAIL_INPUTS || path.join(__dirname, '../orion-base/retail'));
const {prepareLobbyAssets} = require(app + '/dist/node/desktop/native-lobby.js');
const {patchFor} = require(app + '/dist/node/server/gameplay.js');
const {rulesetFor} = require(app + '/dist/node/server/research-publication.js');
const ui = require(native + '/lobby/supcom2-ui.cjs');
const builder = require(native + '/lobby/indexed-probe.cjs');
const inputs = ['ui.scd', 'toc.win.bdf', 'ui.scd.enc'].map(name => sync.readFileSync(path.join(retail, name)));
const hud = sync.readFileSync(path.join(retail, 'lua.scd'));
const art = native + '/lobby/art';
const textures = require(art + '/art-manifest.json').textures.map(t => ({
    name: 'textures/ui/common/pc/frontend/' + t.name,
    data: sync.readFileSync(path.join(art, t.name))
}));
const draft = structuredClone(require(app + '/dist/node/server/data/research-retail.json').draft);
draft.title = 'Transition regression research';
draft.nodes.find(n => n.id === 'ULB_RANGE').cost += 1;
const research = rulesetFor(draft);
const gameplay = patchFor('reforged-balance', '1.0.0', research, undefined, process.env.AI_REVISION);
const progress = [];

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforged-interface-'));
    const data = path.join(root, 'gamedata');
    const state = path.join(root, 'revival-prepared/reforged-lobby-v1');
    try {
        await fs.mkdir(data);
        const control = builder.build(...inputs, false);
        for (const [name, bytes] of [
            ['gamedata/ui.scd', inputs[0]], ['toc.original.win.bdf', inputs[1]],
            ['gamedata/ui.scd.enc', inputs[2]], ['gamedata/lua.scd', hud],
            ['toc.win.bdf', control.toc], ['gamedata/' + builder.PROBE_NAME, control.archive]
        ]) await fs.writeFile(path.join(root, name), bytes);
        const run = expected => prepareLobbyAssets(root, native, true, true, 1.125, false,
            (stage, detail) => { progress.push({stage, detail}); if (stage === 'preparing-check-replay-interface' || stage === 'preparing-build-interface') console.log(stage, detail); }, research, expected, true,
            undefined, false, undefined, gameplay);
        const first = await run();
        assert.equal(first.hud.gameplay.patchId, gameplay.id);
        assert.ok(first.cache, 'Packaged catalog must be verified');
        const again = await run(first.cache);
        assert.equal(again.archiveSha256, first.archiveSha256);
        assert.ok(progress.some(e => e.detail?.startsWith('Verified gameplay ')));

        const previousGameplay = patchFor('reforged-balance', '1.0.0', research, '03717');
        const previous = require(native + '/lobby/indexed-probe-v03717.cjs').build(...inputs, {
            layout: true, textures, hud, hudScale: 1.125, legacyReplay: false,
            research, gameplay: previousGameplay, replayPresentation: true,
            replaySimulationRevision: '03717'
        });
        assert.equal(previous.manifest.hud.mode, 'replay-presentation-03717');
        await fs.writeFile(path.join(root, 'toc.win.bdf'), previous.toc);
        await fs.writeFile(path.join(data, builder.PROBE_NAME), previous.archive);
        await fs.writeFile(path.join(state, 'lobby-manifest.json'), JSON.stringify(previous.manifest));
        await fs.writeFile(path.join(state, 'published-gameplay.json'), JSON.stringify(previousGameplay));
        const afterReplay = await run();
        assert.equal(afterReplay.archiveSha256, first.archiveSha256);
        assert.ok(progress.some(e => e.detail === 'Checking saved replay presentation 03717'));
        const entries = ui.readZip(await fs.readFile(path.join(data, builder.PROBE_NAME)), 4096, true);
        if(process.env.AI_REVISION){assert.ok(entries.length>2711);assert.ok(entries.some(e=>e.name.toLowerCase()==='lua/sim/reforged_ai_operations.lua'));assert.equal(afterReplay.hud.gameplay.aiRevision,process.env.AI_REVISION);}else assert.equal(entries.length,2711);
        console.log('Prepared full roster with published research, reused verified cache, and recovered from 0.37.17 replay at HUD scale 1.125.');
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
})().catch(e => {console.error(e); process.exitCode = 1;});
