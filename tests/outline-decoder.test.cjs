const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),test=require('node:test');
function runtime(profiles={}) {
  const c={Uint8Array,DataView,Map,Set,atob,SPDF_GLYPH_FINGERPRINTS:profiles};
  vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../font-outline-decoder.js'),'utf8'),c);return c;
}
function encodedProfile(signature) {
  const bytes=Buffer.alloc(48);signature.rows.forEach((row,i)=>bytes.writeUInt16LE(row,i*2));
  return [signature.aspect,bytes.toString('base64')];
}
function shape(value) {
  const rect=(x,y,w,h)=>[{x,y,on:true},{x:x+w,y,on:true},{x:x+w,y:y+h,on:true},{x,y:y+h,on:true}];
  const paths=[rect(0,0,1,24),rect(31,0,1,24)];
  for(let i=0;i<16;i++)if((value&i).toString(2).replace(/0/g,'').length%2)paths.push(rect(i*2,0,2,16));
  return paths;
}
function makeFont(glyphs) {
  const data=glyphs.map(paths=>{
    const points=paths.flat(),bytes=Buffer.alloc(12+paths.length*2+points.length*5);
    bytes.writeInt16BE(paths.length,0);let at=10,n=0;
    paths.forEach(path=>{n+=path.length;bytes.writeUInt16BE(n-1,at);at+=2;});
    bytes.writeUInt16BE(0,at);at+=2;
    for(const point of points)bytes[at++]=point.on?1:0;
    for(const axis of ['x','y']){let last=0;for(const point of points){bytes.writeInt16BE(point[axis]-last,at);at+=2;last=point[axis];}}
    return bytes;
  });
  const head=Buffer.alloc(54);head.writeInt16BE(1,50);head.writeUInt16BE(1024,18);
  const maxp=Buffer.alloc(6);maxp.writeUInt16BE(glyphs.length,4);
  const loca=Buffer.alloc((glyphs.length+1)*4);let pos=0;data.forEach((part,i)=>{loca.writeUInt32BE(pos,i*4);pos+=part.length;});loca.writeUInt32BE(pos,glyphs.length*4);
  const tables=[['head',head],['maxp',maxp],['loca',loca],['glyf',Buffer.concat(data)]];
  const font=Buffer.alloc(12+tables.length*16+tables.reduce((sum,[,b])=>sum+b.length,0));font.writeUInt32BE(0x10000,0);font.writeUInt16BE(tables.length,4);
  let offset=12+tables.length*16;tables.forEach(([name,bytes],i)=>{font.write(name,12+i*16);font.writeUInt32BE(offset,20+i*16);font.writeUInt32BE(bytes.length,24+i*16);bytes.copy(font,offset);offset+=bytes.length;});return font;
}
test('vector signatures ignore duplicate points and contour starting points',()=>{
  const r=runtime().ScribdOutlineDecoder,path=shape(7);
  const changed=path.map(points=>[points[2],points[2],points[3],points[0],points[1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.signature(changed))),JSON.parse(JSON.stringify(r.signature(path))));
});
test('bounded TrueType reader recovers signed outline coordinates and rejects bad offsets',()=>{
  const r=runtime().ScribdOutlineDecoder,font=makeFont([shape(5)]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.fontReader(font).contours(0))),shape(5));
  const broken=Buffer.from(font);broken.writeUInt32BE(0xffffffff,20);
  assert.throws(()=>r.fontReader(broken),/bounds/);
  assert.throws(()=>r.fontReader(font).contours(1),/outline/);
});
test('local profiles recover different keys without relying on glyph order',()=>{
  for(const key of [Array.from({length:16},(_,i)=>(i*5+3)%16),Array.from({length:16},(_,i)=>15-i)]) {
    const c=runtime(),profiles={},glyphs=[],cmap=[];
    // Deliberately shuffled glyph IDs across 32 independent ASCII anchors.
    for(let block=0x30;block<=0x40;block+=16)for(let plain=15;plain>=0;plain--) {
      const paths=shape(plain);profiles[block+plain]=[encodedProfile(c.ScribdOutlineDecoder.signature(paths))];
      cmap.push({code:block+key[plain],glyph:glyphs.length});glyphs.push(paths);
    }
    c.SPDF_GLYPH_FINGERPRINTS=profiles;
    const decoder=c.ScribdOutlineDecoder.infer([{family:'ff2',bytes:makeFont(glyphs)}],()=>cmap);
    assert.ok(decoder);assert.deepEqual(Array.from(decoder.inverse),Array.from({length:16},(_,encoded)=>key.indexOf(encoded)));
    assert.equal(decoder.mappings.get('ff2').get(0x40+key[1]),'A');
  }
});
test('insufficient or contradicted geometric evidence cannot produce a decoder',()=>{
  const c=runtime(),profiles={},glyphs=[],cmap=[];
  for(let block=0x30;block<=0x40;block+=16)for(let plain=0;plain<16;plain++){
    profiles[block+plain]=[encodedProfile(c.ScribdOutlineDecoder.signature(shape(plain)))];
    cmap.push({code:block+plain,glyph:glyphs.length});glyphs.push(shape(plain));
  }
  c.SPDF_GLYPH_FINGERPRINTS=profiles;const bytes=makeFont(glyphs);
  assert.equal(c.ScribdOutlineDecoder.infer([{family:'ff0',bytes}],()=>cmap.slice(0,10)),null);
  const conflict=cmap.map(x=>({...x}));[conflict[16].glyph,conflict[17].glyph]=[conflict[17].glyph,conflict[16].glyph];
  assert.equal(c.ScribdOutlineDecoder.infer([{family:'ff0',bytes}],()=>conflict),null);
});
test('malformed reference profiles fail closed',()=>{
  const c=runtime({65:[[1000,'AAAA']]});
  assert.equal(c.ScribdOutlineDecoder.infer([],()=>[]),null);
});

test('main decoder uses outline evidence rather than a uniquely wrong glyph-ID order',()=>{
  const c=runtime(),profiles={},glyphs=[],cmap=[];
  for(let block=0x30;block<=0x40;block+=16)for(let plain=15;plain>=0;plain--){
    const paths=shape(plain);profiles[block+plain]=[encodedProfile(c.ScribdOutlineDecoder.signature(paths))];
    cmap.push({code:block+plain,glyph:glyphs.length+1});glyphs.push(paths);
  }
  // Glyph zero is reserved; the remaining IDs descend by character code.
  const bytes=makeFont([[],...glyphs]);c.SPDF_GLYPH_FINGERPRINTS=profiles;
  c.chrome={runtime:{onMessage:{addListener(){}}}};c.TextEncoder=TextEncoder;
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../builder.js'),'utf8'),c);
  const originalRead=c.readSfntCmap;c.readSfntCmap=()=>cmap;
  const decoder=c.inferFontTextDecoder([{family:'ff0',bytes,cmap}]);
  assert.equal(c.decodeFontText('AB','ff0',decoder).copyText,'AB');
  c.readSfntCmap=originalRead;
});
