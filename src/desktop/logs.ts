import { open } from 'node:fs/promises';
import { isSteamLobbyId, type GameLogReport } from '../shared/model';

export function parseGameLog(contents: string): GameLogReport {
  let lobbyId: string | null = null;
  let state: GameLogReport['state'] = 'no-session';
  for (const line of contents.split(/[\r\n]+/)) {
    const join = line.match(/SteamMatchmaking\(\)->JoinLobby\(\s*([0-9]+)\s*\)/);
    if (join) { lobbyId = isSteamLobbyId(join[1]) ? join[1] : null; state = lobbyId ? 'join-requested' : 'no-session'; }
    if (/SteamMatchmaking\(\)->CreateLobby\(/.test(line)) { lobbyId = null; state = 'no-session'; }
    if (/SteamConnObject::OnLobbyEntered:\s*success/.test(line) && lobbyId) state = 'entered';
    if (/SteamConnObject::OnLobbyEntered:/.test(line) && !/OnLobbyEntered:\s*success/.test(line)) { lobbyId = null; state = 'failed'; }
    if (/SteamMatchmaking\(\)->LeaveLobby\(/.test(line) || /CloseConnector|Run time:/.test(line)) state = 'left';
  }
  const message = state === 'entered' ? 'Log records successful lobby entry. Confirm the host still has this exact lobby open before publishing its ID.'
    : state === 'join-requested' ? 'Log records a join request only; entry is not confirmed. Confirm the current host lobby before publishing.'
    : state === 'left' ? 'This player left or closed the connection. Any last join ID is historical; the host must confirm that lobby remains open.'
    : state === 'failed' ? 'Log records a failed lobby-entry callback. No active lobby ID can be inferred.'
    : 'No join ID found. Startup-only or host-creation logs may not include an active lobby ID.';
  return { lobbyId, state, message };
}

// Read a bounded tail. Paths come only from our last launch or a native picker.
export async function readGameLog(filePath: string): Promise<GameLogReport> {
  const file = await open(filePath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Select a game log file.');
    const length = Math.min(info.size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, info.size - length);
    let contents = buffer.subarray(0, bytesRead).toString('utf8');
    if (info.size > length) contents = contents.slice(contents.indexOf('\n') + 1);
    return parseGameLog(contents);
  } finally { await file.close(); }
}
