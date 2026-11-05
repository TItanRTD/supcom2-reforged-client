const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lobby, ApiError } = require('../dist/node/server/lobby.js');
const { PROTOCOL, STEAM_LINK_TTL_MS } = require('../dist/node/shared/model.js');
const ID = '109775241566054442'; // Historical fixture, never a production default.
function fixture(lobby = new Lobby()) {
  const host = lobby.connect('Host', PROTOCOL).token;
  const guest = lobby.connect('Guest', PROTOCOL).token;
  const roomId = lobby.act(host, 'create', { name: 'Steam test' }).room.id;
  lobby.act(guest, 'join', { roomId });
  const state = () => lobby.snapshot(host).room;
  const publish = (id = ID) => lobby.act(host, 'steam-publish', { lobbyId: id, confirmCurrent: true, expectedLinkId: state().steamLink?.id ?? null }).room.steamLink;
  return { lobby, host, guest, roomId, state, publish };
}
const status = expected => e => e instanceof ApiError && e.status === expected;
test('only the current room host publishes and only room members receive the exact ID', () => {
  const x = fixture(); const outsider = x.lobby.connect('Other', PROTOCOL).token;
  assert.throws(() => x.lobby.act(x.guest, 'steam-publish', { lobbyId: ID, confirmCurrent: true, expectedLinkId: null }), status(403));
  const link = x.publish();
  assert.equal(x.lobby.snapshot(x.guest).room.steamLink.lobbyId, ID);
  assert.equal(link.publishedBy, x.state().hostId);
  assert.ok(!JSON.stringify(x.lobby.snapshot(outsider)).includes(ID));
  assert.throws(() => x.lobby.act(outsider, 'steam-ticket', { linkId: link.id }), status(409));
  assert.throws(() => x.lobby.act(x.guest, 'steam-clear', { linkId: link.id }), status(403));
});
test('Steam publishing requires explicit current-lobby confirmation and rejects invalid IDs', () => {
  const x = fixture();
  for (const value of [null, 109775241566054442, '', '0', '01', '-1', '1 /log bad', '18446744073709551616']) {
    assert.throws(() => x.lobby.act(x.host, 'steam-publish', { lobbyId: value, confirmCurrent: true, expectedLinkId: null }), status(400));
  }
  assert.throws(() => x.lobby.act(x.host, 'steam-publish', { lobbyId: ID, expectedLinkId: null }), /Confirm/);
  assert.equal(x.state().steamLink, null);
});
test('replacement and clearing reject stale link references and stale guest join requests', () => {
  const x = fixture(); const first = x.publish(); const next = x.publish('109775241566054443');
  assert.notEqual(first.id, next.id);
  assert.throws(() => x.lobby.act(x.guest, 'steam-ticket', { linkId: first.id }), status(409));
  assert.throws(() => x.lobby.act(x.host, 'steam-clear', { linkId: first.id }), status(409));
  assert.throws(() => x.lobby.act(x.host, 'steam-publish', { lobbyId: ID, confirmCurrent: true, expectedLinkId: first.id }), status(409));
  assert.equal(x.lobby.act(x.guest, 'steam-ticket', { linkId: next.id }).room.steamLink.lobbyId, next.lobbyId);
  x.lobby.act(x.host, 'steam-clear', { linkId: next.id });
  assert.throws(() => x.lobby.act(x.guest, 'steam-ticket', { linkId: next.id }), status(409));
});
test('links survive guest arrival and choices but are cleared when the community host leaves', () => {
  const x = fixture(); const link = x.publish();
  const other = x.lobby.connect('Third', PROTOCOL).token;
  x.lobby.act(other, 'join', { roomId: x.roomId });
  x.lobby.act(x.guest, 'player', { faction: 'Cybran', team: 3, colour: 'Yellow' });
  assert.equal(x.state().steamLink.id, link.id);
  x.lobby.act(other, 'leave', {});
  assert.equal(x.state().steamLink.id, link.id);
  x.lobby.disconnect(x.host);
  assert.equal(x.lobby.snapshot(x.guest).room.steamLink, null);
});
test('published links expire server-side and cannot be used by stale clients', () => {
  let now = 0; const x = fixture(new Lobby(() => now, STEAM_LINK_TTL_MS * 10)); const link = x.publish();
  now = STEAM_LINK_TTL_MS;
  assert.throws(() => x.lobby.act(x.guest, 'steam-ticket', { linkId: link.id }), status(409));
  assert.equal(x.state().steamLink, null);
});
test('publishing and join tickets preserve readiness and cloned links do not mutate the server', () => {
  const x = fixture();
  x.lobby.act(x.host, 'ready', { ready: true }); x.lobby.act(x.guest, 'ready', { ready: true });
  const link = x.publish(); link.lobbyId = '1';
  assert.equal(x.state().steamLink.lobbyId, ID);
  const revision = x.state().revision;
  x.lobby.act(x.guest, 'steam-ticket', { linkId: link.id });
  assert.equal(x.state().revision, revision);
  assert.ok(x.state().players.every(p => p.ready));
});

test('join titles come from the authenticated current room and refuse other rooms or stale links',async()=>{
 const {joinedRoomTitle}=require('../dist/node/desktop/room-share'),{PROTOCOL}=require('../dist/node/shared/model'),context={server:'http://127.0.0.1:47821',token:'a'.repeat(64),roomId:'11111111-1111-1111-1111-111111111111'},lobbyId='10977524123456789';
 const state=()=>({protocol:PROTOCOL,playerId:'guest',room:{id:context.roomId,name:'TitanRT lobby',players:[{id:'guest'}],steamLink:{lobbyId,expiresAt:new Date(Date.now()+15000).toISOString()}}});assert.equal(await joinedRoomTitle(context,lobbyId,async()=>state()),'TitanRT lobby');for(const change of [s=>s.playerId='outsider',s=>s.protocol++,s=>s.room.id='other',s=>s.room.steamLink.lobbyId='different',s=>s.room.steamLink.expiresAt='invalid',s=>s.room.steamLink.expiresAt=new Date(0).toISOString()]){const s=state();change(s);await assert.rejects(joinedRoomTitle(context,lobbyId,async()=>s));}
});
