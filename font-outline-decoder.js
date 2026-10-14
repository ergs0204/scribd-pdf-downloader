// Local vector-signature fallback for older subsets with shuffled glyph IDs.
// No OCR, font substitution, document keys, dictionaries, or network requests.
globalThis.ScribdOutlineDecoder = (() => {
  const WIDTH=16, HEIGHT=24, MAX_POINTS=8192;
  let references;
  const popcount=value=>{value-=(value>>>1)&0x5555;value=(value&0x3333)+((value>>>2)&0x3333);return (((value+(value>>>4))&0x0f0f)*0x0101)>>>8&255;};
  function referenceIndex() {
    if (references) return references;
    references=new Map();
    for(const [code,profiles] of Object.entries(globalThis.SPDF_GLYPH_FINGERPRINTS||{})) {
      references.set(Number(code),profiles.map(([aspect,packed])=>{
        const bytes=Uint8Array.from(atob(packed),char=>char.charCodeAt(0));
        if(bytes.length!==HEIGHT*2 || !(aspect>0))throw Error('Invalid glyph profile');
        return {aspect,rows:Array.from({length:HEIGHT},(_,i)=>bytes[i*2]|bytes[i*2+1]<<8)};
      }));
    }
    return references;
  }
  function fontReader(bytes) {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const check=(at,length,end=bytes.length)=>{if(!Number.isInteger(at)||at<0||length<0||at+length>end)throw Error('Font bounds');};
    const u16=at=>{check(at,2);return view.getUint16(at);};
    const i16=at=>{check(at,2);return view.getInt16(at);};
    const u32=at=>{check(at,4);return view.getUint32(at);};
    check(0,12);const count=u16(4);if(count>256)throw Error('Font tables');check(12,count*16);
    const tables=new Map();
    for(let i=0;i<count;i++) {
      const at=12+i*16,name=String.fromCharCode(...bytes.subarray(at,at+4)),offset=u32(at+8),length=u32(at+12);
      check(offset,length);tables.set(name,{offset,end:offset+length});
    }
    const head=tables.get('head'),maxp=tables.get('maxp'),loca=tables.get('loca'),glyf=tables.get('glyf');
    if(!head||!maxp||!loca||!glyf)throw Error('No TrueType outlines');
    check(head.offset,54,head.end);check(maxp.offset,6,maxp.end);
    const long=i16(head.offset+50),glyphCount=u16(maxp.offset+4);
    if(![0,1].includes(long)||glyphCount>65535)throw Error('Outline format');
    check(loca.offset,(glyphCount+1)*(long?4:2),loca.end);
    const offset=id=>long?u32(loca.offset+id*4):u16(loca.offset+id*2)*2;
    const cache=new Map();
    function contours(id,depth=0) {
      if(depth>12||id<0||id>=glyphCount)throw Error('Composite outline');
      if(cache.has(id))return cache.get(id);
      let at=glyf.offset+offset(id);const end=glyf.offset+offset(id+1);
      if(end<at||end>glyf.end)throw Error('Glyph bounds');
      if(end===at)return [];
      const requireBytes=length=>check(at,length,end);
      requireBytes(10);const count=i16(at);at+=10;
      let result=[];
      if(count>=0) {
        if(count>512)throw Error('Too many contours');
        requireBytes(count*2+2);const ends=Array.from({length:count},(_,i)=>u16(at+i*2));at+=count*2;
        for(let i=1;i<ends.length;i++)if(ends[i]<=ends[i-1])throw Error('Contour order');
        const points=count?ends[count-1]+1:0;if(points>MAX_POINTS)throw Error('Too many points');
        const instructions=u16(at);at+=2;requireBytes(instructions);at+=instructions;
        const flags=[];
        while(flags.length<points) {
          requireBytes(1);const flag=bytes[at++];flags.push(flag);
          if(flag&8){requireBytes(1);const repeat=bytes[at++];if(flags.length+repeat>points)throw Error('Repeat flags');for(let j=0;j<repeat;j++)flags.push(flag);}
        }
        const coordinates=flags.map(flag=>({on:!!(flag&1),x:0,y:0}));
        for(const [axis,short,same] of [['x',2,16],['y',4,32]]) {
          let value=0;
          flags.forEach((flag,i)=>{
            if(flag&short){requireBytes(1);value+=(flag&same?1:-1)*bytes[at++];}
            else if(!(flag&same)){requireBytes(2);value+=i16(at);at+=2;}
            coordinates[i][axis]=value;
          });
        }
        let start=0;
        result=ends.map(endPoint=>{const value=coordinates.slice(start,endPoint+1);start=endPoint+1;return value;});
      } else if(count===-1) {
        let flag,parts=0;
        do {
          if(++parts>64)throw Error('Composite parts');
          requireBytes(4);flag=u16(at);const child=u16(at+2);at+=4;
          if(!(flag&2))throw Error('Point-aligned composite unsupported');
          let x,y;
          if(flag&1){requireBytes(4);x=i16(at);y=i16(at+2);at+=4;}
          else{requireBytes(2);x=view.getInt8(at);y=view.getInt8(at+1);at+=2;}
          let a=1,b=0,c=0,d=1;
          if(flag&8){requireBytes(2);a=d=i16(at)/16384;at+=2;}
          else if(flag&64){requireBytes(4);a=i16(at)/16384;d=i16(at+2)/16384;at+=4;}
          else if(flag&128){requireBytes(8);a=i16(at)/16384;b=i16(at+2)/16384;c=i16(at+4)/16384;d=i16(at+6)/16384;at+=8;}
          if(flag&2048){const xx=a*x+c*y;y=b*x+d*y;x=xx;}
          const transformed=contours(child,depth+1).map(contour=>contour.map(p=>({x:a*p.x+c*p.y+x,y:b*p.x+d*p.y+y,on:p.on})));
          result.push(...transformed);
          if(result.reduce((sum,contour)=>sum+contour.length,0)>MAX_POINTS)throw Error('Composite point limit');
        }while(flag&32);
      } else throw Error('Invalid contours');
      cache.set(id,result);return result;
    }
    return {contours};
  }
  function flatten(contour) {
    if(!contour.length)return [];
    const midpoint=(p,q)=>({x:(p.x+q.x)/2,y:(p.y+q.y)/2,on:true});
    const first=contour[0],last=contour[contour.length-1];
    const start=first.on?first:last.on?last:midpoint(last,first);
    const remaining=first.on?contour.slice(1):last.on?contour.slice(0,-1):contour.slice();
    remaining.push(start);const points=[start];
    for(let i=0;i<remaining.length;) {
      const p=remaining[i];
      if(p.on){points.push(p);i++;continue;}
      const next=remaining[i+1]||start,end=next.on?next:midpoint(p,next),begin=points[points.length-1];
      for(let step=1;step<=12;step++){const t=step/12,u=1-t;points.push({x:u*u*begin.x+2*u*t*p.x+t*t*end.x,y:u*u*begin.y+2*u*t*p.y+t*t*end.y});}
      i+=next.on?2:1;
    }
    return points;
  }
  function signature(contours) {
    const paths=contours.map(flatten),points=paths.flat();
    if(!points.length)return null;
    let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
    for(const p of points){xmin=Math.min(xmin,p.x);xmax=Math.max(xmax,p.x);ymin=Math.min(ymin,p.y);ymax=Math.max(ymax,p.y);}
    const dx=xmax-xmin,dy=ymax-ymin;if(!(dx>0&&dy>0))return null;
    const normalized=paths.map(path=>path.map(p=>({x:(p.x-xmin)/dx,y:(p.y-ymin)/dy})));
    const rows=[];
    for(let row=0;row<HEIGHT;row++) {
      const y=(row+.5)/HEIGHT,crossings=[];
      for(const path of normalized)for(let i=0;i<path.length;i++) {
        const p=path[i],q=path[(i+1)%path.length];
        if(p.y<=y&&y<q.y||q.y<=y&&y<p.y)crossings.push([p.x+(y-p.y)*(q.x-p.x)/(q.y-p.y),q.y>p.y?1:-1]);
      }
      let bits=0;
      for(let col=0;col<WIDTH;col++){const x=(col+.5)/WIDTH;let winding=0;for(const [at,sign] of crossings)if(at<=x)winding+=sign;if(winding)bits|=1<<col;}
      rows.push(bits);
    }
    return {rows,aspect:Math.round(dx/dy*1000)};
  }
  function distance(source,target) {
    if(!(source.aspect>0&&target.aspect>0))return Infinity;
    return source.rows.reduce((sum,row,i)=>sum+popcount(row^target.rows[i]),0)/(WIDTH*HEIGHT)+Math.abs(Math.log(source.aspect/target.aspect))*.10;
  }
  function infer(fonts,readCmap) {
    try {
      const refs=referenceIndex();if(!refs.size)return null;
      const faces=[];let budget=0;
      for(const font of fonts.slice(0,32)) {
        if(!font.bytes)continue;
        try {
          const reader=fontReader(font.bytes),cmap=readCmap(font.bytes,0x20,0x27af),glyphs=[];
          for(const {code,glyph} of cmap) {
            if(++budget>4096)return null;
            let sig;try{sig=signature(reader.contours(glyph));}catch(_){continue;}
            if(!sig)continue;
            const score=target=>{const profiles=refs.get(target);return profiles?Math.min(...profiles.map(profile=>distance(sig,profile))):Infinity;};
            const ranked=[];
            for(let candidate=code&~15;candidate<(code&~15)+16;candidate++){const error=score(candidate);if(Number.isFinite(error))ranked.push({code:candidate,error});}
            ranked.sort((a,b)=>a.error-b.error);
            glyphs.push({code,sig,score,ranked});
          }
          faces.push({family:font.family.replace(/^["']|["']$/g,'').toLowerCase(),glyphs,cmap});
        }catch(_){/* Malformed/unsupported faces are not guessed. */}
      }
      const inverse=Array(16),used=new Set();let anchors=0;
      for(const face of faces)for(const glyph of face.glyphs) {
        if(glyph.code<0x30||glyph.code>=0x70||glyph.ranked.length<2)continue;
        const [best,next]=glyph.ranked;
        if(best.error>.13||next.error-best.error<.06)continue;
        const encoded=glyph.code&15,plain=best.code&15;
        if(inverse[encoded]!==undefined&&inverse[encoded]!==plain)return null;
        inverse[encoded]=plain;anchors++;
      }
      for(const value of inverse){if(value===undefined||used.has(value))return null;used.add(value);}
      if(anchors<24)return null;
      const mappings=new Map();
      for(const face of faces) {
        const groups=new Map(),mapping=new Map();
        for(const glyph of face.glyphs){const block=glyph.code&~15;if(!groups.has(block))groups.set(block,[]);groups.get(block).push(glyph);}
        for(const [block,glyphs] of groups) {
          const permuted=code=>(code&~15)|inverse[code&15];
          let scrambled;
          if(block>=0x30&&block<0x70)scrambled=true;
          else if(block<0x30)scrambled=false;
          else {
            const evidence=glyphs.filter(g=>g.code!==permuted(g.code)&&Number.isFinite(g.score(g.code))&&Number.isFinite(g.score(permuted(g.code))));
            if(!evidence.length) {
              for(const g of glyphs)if((g.code===permuted(g.code)||!Number.isFinite(g.score(permuted(g.code))))&&g.score(g.code)<=.13)mapping.set(g.code,String.fromCodePoint(g.code));
              continue;
            }
            const mean=transform=>evidence.reduce((sum,g)=>sum+g.score(transform(g.code)),0)/evidence.length;
            const identity=mean(code=>code),changed=mean(permuted);
            if(changed<=.16&&identity-changed>=.025)scrambled=true;
            else if(identity<=.16&&changed-identity>=.025)scrambled=false;
            else continue;
          }
          for(const glyph of glyphs){const decoded=scrambled?permuted(glyph.code):glyph.code;if(glyph.score(decoded)<=.20)mapping.set(glyph.code,String.fromCodePoint(decoded));}
        }
        for(const {code} of face.cmap)if(code===0x20||code===0xa0)mapping.set(code,String.fromCodePoint(code));
        if(mapping.size)mappings.set(face.family,mapping);
      }
      return mappings.size?{inverse,mappings,families:new Set(mappings.keys()),method:'outline-signatures'}:null;
    }catch(_){return null;}
  }
  return {infer,fontReader,signature,distance};
})();
