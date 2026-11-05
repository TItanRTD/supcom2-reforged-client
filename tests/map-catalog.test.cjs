const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib');
const {LocalMapCatalog,parseScenario,decodeMapPreview,crc32,indexArchive,readEntry}=require('../dist/node/desktop/map-catalog');
function zip(entries){let offset=0;const local=[],central=[];for(const [name,text]of Object.entries(entries)){const n=Buffer.from(name),data=Buffer.isBuffer(text)?text:Buffer.from(text),compressed=zlib.deflateRawSync(data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(8,8);h.writeUInt32LE(crc32(data),14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);local.push(h,n,compressed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(8,10);c.writeUInt32LE(crc32(data),16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+compressed.length;}const center=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(center.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,center,end]);}
const scenario=(name='Test battlefield',count=4)=>`version=3\nScenarioInfo={name='<LOC test_map>${name}',type='skirmish',map='/maps/Test/Test.scmap',Configurations={teams={{armies={${Array.from({length:count},(_,i)=>`'ARMY_${i+1}'`).join(',')}}}}}}`;
function dds(kind='DXT1'){const b=Buffer.alloc(kind==='DXT1'?136:144);b.write('DDS ');b.writeUInt32LE(124,4);b.writeUInt32LE(4,12);b.writeUInt32LE(4,16);b.write(kind,84);const at=kind==='DXT1'?128:136;b.writeUInt16LE(0xf800,at);b.writeUInt16LE(0x07e0,at+2);if(kind==='DXT3')b.fill(255,128,136);if(kind==='DXT5')b[128]=255;return b;}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'s2r-map-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'gamedata'));await fs.mkdir(path.join(root,'bin'));return root;}
test('installed SCD catalog reads skirmish scenarios and cross-archive minimaps without executing Lua',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'gamedata/maps.scd'),zip({'maps/Test/Test.minimap.win.dds':dds()}));
 await fs.writeFile(path.join(root,'gamedata/uncompiled_lua.scd'),zip({'maps/Test/Test_scenario.lua':scenario()+`\nos.execute('THIS_MUST_NEVER_RUN')`,'maps/Campaign/Campaign_scenario.lua':scenario().replace("'skirmish'","'campaign'")}));
 const catalog=new LocalMapCatalog(),r=await catalog.scan(path.join(root,'bin/SupremeCommander2.exe'));
 assert.equal(r.maps.length,1);assert.equal(r.maps[0].name,'Test battlefield');assert.equal(r.maps[0].players,4);assert.match(r.maps[0].metadataHash,/^[a-f0-9]{64}$/);assert.match(await catalog.preview(r.maps[0].id),/^data:image\/png;base64,/);assert.equal(r.warnings.length,0);
 await assert.rejects(catalog.preview('/etc/passwd'),/Rescan/);
});
test('map metadata ignores comments, preserves escaped names, rejects compiled/invalid scenarios',()=>{
 assert.equal(parseScenario(Buffer.from(`-- name='WRONG'\n`+scenario("Pilot\\'s \"Test\"")), 'maps/Test/Test_scenario.lua').name,`Pilot's "Test"`);
 assert.equal(parseScenario(Buffer.from([27,76,117,97]),'maps/Test/Test_scenario.lua'),null);
 assert.equal(parseScenario(Buffer.from(scenario()),'maps/../Test_scenario.lua'),null);
 assert.equal(parseScenario(Buffer.from('os.execute("bad")'),'maps/Test/Test_scenario.lua'),null);
});
test('custom archive overrides metadata, malformed archives are reported and scan refresh removes uninstalled maps',async t=>{
 const root=await fixture(t),dir=path.join(root,'gamedata'),catalog=new LocalMapCatalog();
 await fs.writeFile(path.join(dir,'a.scd'),zip({'maps/Test/Test_scenario.lua':scenario('First')}));await fs.writeFile(path.join(dir,'z.scd'),zip({'maps/Test/Test_scenario.lua':scenario('Override',2)}));await fs.writeFile(path.join(dir,'broken.scd'),'broken');
 let r=await catalog.scan(path.join(root,'bin/SupremeCommander2.exe'));assert.equal(r.maps.length,1);assert.equal(r.maps[0].name,'Override');assert.equal(r.maps[0].players,2);assert.equal(r.warnings.length,1);
 await fs.unlink(path.join(dir,'a.scd'));await fs.unlink(path.join(dir,'z.scd'));r=await catalog.scan(path.join(root,'bin/SupremeCommander2.exe'));assert.equal(r.maps.length,0);await assert.rejects(catalog.preview('/maps/Test/Test_scenario.lua'));
});
test('archive CRC and size bounds are enforced and entry paths cannot become filesystem reads',async t=>{
 const root=await fixture(t),file=path.join(root,'gamedata/test.scd'),bytes=zip({'maps/Test/Test_scenario.lua':scenario(),'../private.lua':'bad'});await fs.writeFile(file,bytes);let a=await indexArchive(file);assert.equal(a.entries.length,1);await assert.rejects(readEntry(a,a.entries[0],1),/oversized/);
 const offset=bytes.indexOf(Buffer.from('PK\x01\x02'));bytes.writeUInt32LE(1,offset+16);await fs.writeFile(file,bytes);a=await indexArchive(file);await assert.rejects(readEntry(a,a.entries[0]),/checksum/);
});
test('DDS preview decodes DXT1/3/5 colour and alpha; truncated and oversized images are refused',()=>{
 for(const kind of ['DXT1','DXT3','DXT5']){const value=decodeMapPreview(dds(kind));assert.match(value,/^data:image\/png;base64,/);const png=Buffer.from(value.split(',')[1],'base64');assert.equal(png.readUInt32BE(16),4);assert.equal(png.readUInt32BE(20),4);let at=8,raw;while(at<png.length){const n=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8);if(type==='IDAT')raw=zlib.inflateSync(png.subarray(at+8,at+8+n));at+=n+12;}assert.deepEqual([...raw.subarray(1,5)],[255,0,0,255]);}
 assert.equal(decodeMapPreview(dds().subarray(0,130)),null);const huge=dds();huge.writeUInt32LE(99999,12);assert.equal(decodeMapPreview(huge),null);
});

test('a promotional display image is not presented as a terrain minimap',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'gamedata/maps.scd'),zip({'maps/Test/Test_scenario.lua':scenario(),'maps/Test/preview.dds':dds()}));const catalog=new LocalMapCatalog();await catalog.scan(path.join(root,'bin/SupremeCommander2.exe'));assert.equal(await catalog.preview('/maps/Test/Test_scenario.lua'),null);
});

test('supplied original maps expose verified spawn coordinates through the real scanner',{skip:!process.env.SUPCOM2_ASSETS_FIXTURE},async t=>{
 const root=await fixture(t),file=path.join(process.env.SUPCOM2_ASSETS_FIXTURE,'uncompiled_lua.scd');await fs.copyFile(file,path.join(root,'gamedata/uncompiled_lua.scd'));const catalog=new LocalMapCatalog(),result=await catalog.scan(path.join(root,'bin/SupremeCommander2.exe'));assert.ok(result.maps.length>=26);assert.ok(result.maps.every(m=>m.starts?.points.length===m.players));
 const shipyard=result.maps.find(m=>m.name.includes('Coalition Shipyard')),palms=result.maps.find(m=>m.name.includes('Open Palms'));assert.ok(shipyard&&palms);assert.deepEqual(shipyard.starts,{width:1024,height:1024,points:[{slot:0,x:512.435,z:712.51},{slot:1,x:512.435,z:314.51}]});assert.equal(palms.starts.points.length,6);assert.deepEqual(catalog.metadata(shipyard.id).starts,shipyard.starts);
});
