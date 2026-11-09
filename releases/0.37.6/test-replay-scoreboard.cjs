'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const app = process.env.PACKAGED_APP || base+'/app';
const desk = app+'/dist/node/desktop/';
const { encodeLobbyServices, encodeReplayScoreboard, LobbyServices } = require(desk+'lobby-services');
const { replayPlayers, snapshotReplayPlayers, finishSavedReplay, readReplayMetadata } = require(desk+'replay-provenance');
const { validateReplayMetadata } = require(app+'/dist/node/server/replay-metadata');
const { CLIENT_VERSION } = require(app+'/dist/node/shared/model');

(async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 's2r-replay-scoreboard-'));
    try {
        let now = 10000, rating = 16.2;
        const makeSample = launched => ({ visible: !launched, nativeLaunchState: [Number(launched), 0], roster: { ReadOK: true, Entries: [
            { Name: 'TitanRT', Team: 1, AI: false, Observer: false, StartPosition: 7 },
            { Name: 'Other', Team: 2, AI: false, Observer: false, StartPosition: 0 },
            { Name: 'Computer', Team: 2, AI: true, Observer: false, StartPosition: 1 },
        ] } });
        const directory = () => [{ name: 'TitanRT', rating, games: 3, badges: [
            { id: 'experience-2', label: 'Experience' }, { id: 'owner-developer', label: 'Developer' },
        ] }, { name: 'Other', rating: 10.5, games: 2 }];
        const services = new LobbyServices({ roomId: 'test' }, path.join(temp, 'lobby-services.bin'), () => now);
        services.request = async () => ({ roomId: 'test', players: directory() });
        await services.tick(makeSample(false));
        rating = 24;
        now += 2000;
        await services.tick(makeSample(true));
        const roster = snapshotReplayPlayers(replayPlayers(makeSample(true)), services.scoreboard);
        assert.equal(roster[0].rating, 16.2);
        assert.equal(roster[0].badgeCode, 163);
        assert.equal(roster[1].rating, 10.5);
        assert.equal(roster[2].rating, undefined);
        const file = path.join(temp, 'match.SC2Replay');
        await fs.writeFile(file, 'Replay v1.9\r\nScoreboard fixture');
        const saved = await finishSavedReplay(file, roster, CLIENT_VERSION);
        const meta = await readReplayMetadata(saved);
        assert.deepEqual(meta.players, [roster[0], roster[1], { name: 'Computer', team: 2, ai: true, observer: false }]);
        assert.deepEqual(validateReplayMetadata(meta, meta.sha256), meta);
        assert.equal(encodeReplayScoreboard([{ name: 'Older', team: 1, ai: false, observer: false }]), undefined);
        assert.equal(encodeReplayScoreboard([roster[0], {...roster[0], name: 'Wrong'}]), undefined);
        const snapshot = encodeReplayScoreboard(meta.players);
        const live = encodeLobbyServices({ players: directory(), sample: makeSample(false) }, 1);
        assert.equal(live[0x6f8+7], 163);
        assert.equal(snapshot[0x6f8+7], 163);
        assert.equal(snapshot.toString('ascii', 0x738+7*25, 0x738+7*25+7), 'TitanRT');
        assert.ok(Math.abs(snapshot.readFloatLE(0x6a0+7*4)-16.2) < 0.0001);
        assert.equal(snapshot.readFloatLE(0x6a0), 10.5);
        assert.equal(snapshot[0x6f8], 0);
        const swapped = snapshotReplayPlayers([{ ...roster[0], name: 'Different', rating: undefined }], services.scoreboard);
        assert.equal(swapped[0].rating, undefined);
        console.log('Match-start Forge Ratings and badge slots survive save, server validation, and replay playback encoding.');
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
