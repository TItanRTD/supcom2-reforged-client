/** Original Supreme Commander 2 base and DLC recording extensions. Content
 * validation remains independent of the filename, including community imports.
 */
export function isReplayFilename(name:string){return /\.sc2replay(?:dlc)?$/i.test(name);}
