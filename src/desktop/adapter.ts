import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat,open } from 'node:fs/promises';
import path from 'node:path';
import type { DesktopProfile, GameProfile, MatchManifest } from '../shared/model';
import { isSteamLobbyId } from '../shared/model';

// Uploaded executable inspected read-only; direct joining was then tested on Windows.
export const TESTED_EXE_SHA256 = 'e80136ba3851ab6f37a8fb0b7fbcafd9d9276b2f1290911b554973d6a7477581';
export function validateLobbyId(input: unknown): string {
  // Never convert a Steam ID to Number: it can exceed Number.MAX_SAFE_INTEGER.
  if (!isSteamLobbyId(input)) {
    throw new Error('Paste only the decimal Steam lobby ID (up to 64 bits), without spaces or a link.');
  }
  return input;
}
export function steamLaunchArguments(profile: GameProfile, logPath: string, lobbyId?: unknown): string[] {
  if (profile.exeSha256 !== TESTED_EXE_SHA256) throw new Error('This executable has not been verified for Steam join/logging. Use Open SupCom 2 normally and report the executable fingerprint.');
  if (!path.isAbsolute(logPath) || !logPath.endsWith('.sclog')) throw new Error('Invalid diagnostic log path.');
  return [...(lobbyId === undefined ? [] : ['+connect_lobby', validateLobbyId(lobbyId)]), '/log', logPath];
}

// Room-to-match hosting/settings transfer remains a separate unsupported boundary.
export async function inspectExecutable(executable: string): Promise<DesktopProfile> {
  if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'supremecommander2.exe') throw new Error('Select SupremeCommander2.exe in the game’s bin folder.');
  const info = await stat(executable);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error('Invalid SupCom 2 executable.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  const handle=await open(executable,'r');let largeAddressAware:boolean|undefined;
  try{const b=Buffer.alloc(1024);const {bytesRead}=await handle.read(b,0,b.length,0);if(bytesRead>=64&&b.toString('ascii',0,2)==='MZ'){const nt=b.readUInt32LE(60);if(nt+24<=bytesRead&&b.readUInt32LE(nt)===0x4550&&b.readUInt16LE(nt+4)===0x14c)largeAddressAware=!!(b.readUInt16LE(nt+22)&0x20);}}finally{await handle.close();}
  return { path: executable, profile: { exeSha256: hash.digest('hex'), verification: 'exe-only',...(largeAddressAware===undefined?{}:{largeAddressAware}) } };
}
export function multiplayerLaunchPlan(_manifest: MatchManifest): never {
  throw new Error('SupCom 2 room-to-match adapter is not implemented. A manifest does not create a game session.');
}
