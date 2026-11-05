import type { LiveLobby } from '../shared/model';
import { isSteamLobbyId } from '../shared/model';
export const LIVE_MAX_AGE_MS = 4500;
export function isLiveSteamLobbyId(value: unknown): value is string {
  if (!isSteamLobbyId(value)) return false;
  const id = BigInt(value);
  // CSteamID public-universe chat account with the lobby instance flag.
  return (id >> 56n) === 1n && ((id >> 52n) & 15n) === 8n && ((id >> 32n) & 0x40000n) !== 0n;
}
export class LiveLobbyTracker {
  private last: LiveLobby;
  private candidate = '';
  private count = 0;
  private seen = false;
  constructor(private readonly now = Date.now) {
    this.last = { lobbyId: null, status: 'waiting', role: null, observedAt: now(), message: 'Waiting for the game’s lobby state.' };
  }
  unavailable(message = 'Live lobby detection is unavailable. No automatic lobby is shared.'): void {
    this.candidate = ''; this.count = 0;
    this.last = { lobbyId: null, status: 'unavailable', role: null, observedAt: this.now(), message };
  }
  ingest(input: unknown): void {
    if (!input || typeof input !== 'object') { this.unavailable(); return; }
    const r = input as Record<string, unknown>;
    if (r.kind === 'ended') { this.inactive('Game process ended.'); return; }
    if (r.kind !== 'sample' || typeof r.readOK !== 'boolean' || typeof r.visible !== 'boolean' || typeof r.isHost !== 'boolean'
      || !Number.isInteger(r.state) || !Number.isInteger(r.role) || !isSteamLobbyId(r.lobbyId) && r.lobbyId !== '0') {
      this.unavailable('Invalid lobby-reader response; automatic sharing paused.'); return;
    }
    // The legacy reader field named "role" is native header+4. The first live
    // Windows capture has value 0 in a connected host lobby, so it is not a
    // reliable host/guest discriminator. Use the lobby UI's actual host flag;
    // still require readable connected state, visibility, a valid ID and two
    // fresh observations before reporting an active lobby.
    const role = r.isHost ? 'host' : 'guest';
    if (!r.readOK || r.state !== 3 || !r.visible || !isLiveSteamLobbyId(r.lobbyId)) {
      this.inactive(this.seen ? 'No active game lobby is visible. Automatic link cleared.' : 'Waiting for a connected game lobby.'); return;
    }
    const key = `${role}:${r.lobbyId}`;
    this.count = key === this.candidate && this.now() - this.last.observedAt <= LIVE_MAX_AGE_MS ? this.count + 1 : 1; this.candidate = key;
    const active = this.count >= 2;
    if (active) this.seen = true;
    this.last = { lobbyId: active ? r.lobbyId : null, role: active ? role : null,
      status: active ? 'active' : 'waiting', observedAt: this.now(),
      message: active ? `Observed current ${role} lobby ${r.lobbyId}.` : 'Confirming the lobby ID on a second observation.' };
  }
  private inactive(message: string) {
    this.candidate = ''; this.count = 0;
    this.last = { lobbyId: null, status: this.seen ? 'left' : 'waiting', role: null, observedAt: this.now(), message };
  }
  get(): LiveLobby {
    if (this.now() - this.last.observedAt > LIVE_MAX_AGE_MS) return { lobbyId: null, role: null, status: 'unavailable',
      observedAt: this.last.observedAt, message: 'Lobby observation expired; automatic sharing paused.' };
    return { ...this.last };
  }
}
