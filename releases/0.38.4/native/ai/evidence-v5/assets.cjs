'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const normal = entry => entry.name.replaceAll('\\', '/').toLowerCase();
const bytes = name => fs.readFileSync(path.join(__dirname, name));
const aiScript = name => 'lua/sim/reforged_ai_' + name + '.lua';
const moduleEntry = /^(?:mods\/dlc1\/shadow\/)?lua\/(?:sim|system)\/reforged_ai_[a-z_]+\.lua$/;
const RETAIL = 'vanilla-1.260-iwbp';

function apply(bundle, current, originals, gameplay) {
    assert(['evidence-ai-5'].includes(gameplay.aiRevision), 'Unsupported replay AI revision');
    const pinned = JSON.parse(bytes('source-manifest.json'));
    assert.equal(pinned.revision, gameplay.aiRevision);
    for (const [name, expected] of Object.entries(pinned.sources)) assert.equal(crypto.createHash('sha256').update(bytes(name)).digest('hex'), expected, 'Published AI source changed; create a new AI revision: ' + name);
    const retail = gameplay.profileId === RETAIL;
    const scripts = new Map(bundle.scripts.map(entry => [normal(entry), entry]));
    const replace = (name, data) => scripts.set(name, {name, data});
    if (retail) {
        for (const entry of current.scripts) {
            const name = normal(entry);
            if (moduleEntry.test(name)) scripts.set(name, entry);
        }
        assert(scripts.has(aiScript('frame')) && scripts.has(aiScript('knowledge')));
        const selector = 'lua/ui/lobby/aitypes.lua';
        const originalSelector = current.scripts.find(entry => normal(entry) === selector);
        assert(originalSelector, 'Missing Reforger selector');
        scripts.set(selector, originalSelector);
        for (const prefix of ['', 'mods/dlc1/shadow/']) {
            const name = prefix + 'lua/sim/aibrain.lua';
            const previous = scripts.get(name);
            assert(previous, 'Missing retail brain delegate ' + name);
            replace(name, Buffer.concat([previous.data, Buffer.from('\n'), bytes('../replay-ai-v2/retail-brain.lua')]));
        }
    }
    const names = ['planning','tactics','policy','frame','controller','strategy','logistics','openings','knowledge','tasks','trace','resources','adaptive','topology','teamplay','director','doctrine','campaign','expansion','effective','operations'];
    for (const name of names) replace(aiScript(name), bytes(name + '.lua'));
    replace('lua/system/reforged_ai_catalog.lua', bytes('catalog.lua'));
    for (const [stem, hook] of [['defaultweapons', 'projectile-launch-hook.lua'], ['projectile', 'projectile-impact-hook.lua']]) {
        for (const prefix of ['lua/', 'mods/dlc1/shadow/lua/']) {
            const name = prefix + 'sim/' + stem + '.lua';
            const original = scripts.get(name) || originals.find(entry => normal(entry) === name);
            if (!original) continue;
            const saved = 'lua/rf_ai4_' + stem + '_' + (prefix.startsWith('mods') ? 'dlc' : 'base') + '_original.lua';
            replace(saved, original.data);
            replace(name, Buffer.concat([Buffer.from("doscript('/" + saved + "',getfenv(1))\n"), bytes(hook)]));
        }
    }
    replace(aiScript('ruleset'), Buffer.from(
        'ProfileId = ' + JSON.stringify(gameplay.profileId) + '\n'
        + 'PatchId = ' + JSON.stringify(gameplay.id) + '\n'
        + 'Version = ' + JSON.stringify(gameplay.version) + '\n'
    ));

    const loader = 'lua/system/blueprints.lua';
    let blueprintSource = scripts.get(loader)?.data;
    if (retail) {
        const original = originals.find(entry => normal(entry) === loader);
        assert(original && !blueprintSource, 'Missing exact retail blueprint loader');
        const saved = 'lua/rf_replay_ai_retail_blueprints.lua';
        replace(saved, original.data);
        blueprintSource = Buffer.from("doscript('/" + saved + "',getfenv(1))\n");
    }
    assert(blueprintSource, 'Missing active blueprint loader');
    const metadata = 'lua/system/reforged_ai_ruleset_blueprints.lua';
    replace(metadata, bytes('ruleset-blueprints.lua'));
    replace(loader, Buffer.concat([blueprintSource, Buffer.from(`
local rfRulesetMetadata=setmetatable({}, {__index=getfenv(1)})
doscript('/${metadata}',rfRulesetMetadata)
local beforeRFRulesetMetadata=ModBlueprints
function ModBlueprints(all)
    if beforeRFRulesetMetadata then beforeRFRulesetMetadata(all)end
    rfRulesetMetadata.Install(all)
end
`)]));
    return {...bundle, scripts:[...scripts.values()], manifest:{...bundle.manifest, aiRevision:gameplay.aiRevision,
        ...(retail ? {scope:'Retail units, weapons, research and active conversion with Reforged AI presets and orders.'} : {})}};
}

module.exports = {apply};
