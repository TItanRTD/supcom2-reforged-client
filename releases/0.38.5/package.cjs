'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const req=require('node:module').createRequire(path.join(__dirname,'../orion-tooling/node/package.json'));
const PE=req('pe-library'),{Resource}=req('resedit');
const root=path.join(__dirname,'payload');
const file=path.join(root,'Supreme Commander 2 Reforged.exe');
const original=fs.readFileSync(file),exe=PE.NtExecutable.from(original),res=PE.NtExecutableResource.from(exe);
const other=res.entries.filter(e=>e.type!==16).map(e=>[e.type,e.id,e.lang,Buffer.from(e.bin).toString('base64')]);
const vi=Resource.VersionInfo.fromEntries(res.entries);assert.equal(vi.length,1);
vi[0].setFileVersion('0.38.5');vi[0].setProductVersion('0.38.5');vi[0].outputToResourceEntries(res.entries);
res.outputResource(exe);
const bytes=Buffer.from(exe.generate()),parsed=PE.NtExecutable.from(bytes),entries=PE.NtExecutableResource.from(parsed).entries;
assert.deepEqual(entries.filter(e=>e.type!==16).map(e=>[e.type,e.id,e.lang,Buffer.from(e.bin).toString('base64')]),other);
const current=Resource.VersionInfo.fromEntries(entries)[0];
assert.equal(current.fixedInfo.fileVersionMS,38);assert.equal(current.fixedInfo.fileVersionLS,327680);
const before=PE.NtExecutable.from(original).getAllSections().filter(s=>s.info.name!=='.rsrc');
for(const section of before){const after=parsed.getAllSections().find(s=>s.info.name===section.info.name);assert.deepEqual(Buffer.from(after.data||[]),Buffer.from(section.data||[]),section.info.name);}
fs.writeFileSync(file+'.new',bytes);fs.renameSync(file+'.new',file);
const manifest=path.join(root,'resources/installer/owned-files.json'),old=JSON.parse(fs.readFileSync(manifest));
const files=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&f!==manifest)files.push({path:path.relative(root,f).split(path.sep).join('/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')});}}
walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));
fs.writeFileSync(manifest+'.new',JSON.stringify({owner:old.owner,schema:1,version:'0.38.5',owned:[...new Set([...old.owned,...files.map(x=>x.path)])].sort(),files},null,2)+'\n');
fs.renameSync(manifest+'.new',manifest);
console.log('Updated PE version and owned-file manifest:',files.length);
