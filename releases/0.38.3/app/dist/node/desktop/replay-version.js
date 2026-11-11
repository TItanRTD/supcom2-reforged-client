"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPLAY_REVISIONS = void 0;
exports.replayRevision = replayRevision;
exports.validateReplayRevision = validateReplayRevision;
const model_1 = require("../shared/model");
/** Only revisions with a preserved generator can select simulation data. */
exports.REPLAY_REVISIONS = ['0382', '0381', '0380', '03721', '03720', '03719', '03718', '03717', '03716', '03715', '03714', '03713', '03712', '03711', '03710', '0379', '0378', '0377', '0376', '0375', '0374', '0373', '0372', '0371', '0370', '03619', '03618', '03617', '03616', '03615', '03614', '03613', '03612', '03611', '03610', '0369', '0368', '0367', '0366', '0365', '0364', '0363', '0362', '0361', '0355', '0354', '0353', '0352', '0351', '0350', '0343', '0342', '0341', '0340', '0337', '0336', '0335', '0334', '0333', '0332', '0331', '0329', '0328', '0327', '0326', '0325', '0324', '0323', '0322', '0321', '0320', '0313', '0312', '0311', '0310', '0306', '0305', '0304', '0301', '0300', '0292', '0291', '0290', '0282', '0280', '02733', '02732', '02731', '02730', '02729', '02728', '02727', '02726', '02725', '02723', '02722', '02721', '02720', '02719'];
function replayRevision(version) {
    if (version === undefined || version === model_1.CLIENT_VERSION)
        return 'current';
    // 0.36.1 changes lobby presentation and client services only.
    if (version === '0.36.0')
        return '0361';
    if (version === '0.33.0')
        return '0331';
    // 0.30.2/0.30.3 share the delivered 0.30.4 battle profile.
    if (version === '0.30.2' || version === '0.30.3')
        return '0304';
    // 0.28.2 changed client map rendering only; its native profile is 0.28.1.
    if (version === '0.28.1')
        return '0282';
    const known = exports.REPLAY_REVISIONS.find(r => version === `0.${Number(r.slice(1, 3))}.${Number(r.slice(3))}`);
    if (!known)
        throw Error('This Reforged replay requires version ' + version + '. Its simulation profile is not included in this client.');
    return known;
}
function validateReplayRevision(value) {
    if (value === undefined || value === 'current')
        return 'current';
    if (exports.REPLAY_REVISIONS.some(r => r === value))
        return value;
    throw Error('Unsupported replay simulation profile.');
}
