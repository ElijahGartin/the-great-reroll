const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),E=require('../js/deal-engine.js');const ctx={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../data/characters.js'),'utf8'),ctx);const D=ctx.window.GR_CHARACTER_DATA;
const pool=f=>Object.entries(D[f.toUpperCase()]).flatMap(([race,cs])=>cs.map(cls=>({key:race+'|'+cls,race,cls,flex:D.CLASS_SPECS[cls].some(s=>/tank|heal/i.test(s[1]))})));
const names=n=>Array.from({length:n},(_,i)=>'Player '+i);
const verify=g=>{const counts={},ids=new Set();g.players.forEach(p=>{assert.equal(p.hand.length,3);assert.equal(new Set(p.hand.map(c=>c.cls)).size,3);p.hand.forEach(c=>{counts[c.key]=(counts[c.key]||0)+1;assert.ok(counts[c.key]<=g.copies);assert.ok(!ids.has(c.id));ids.add(c.id)})})};
test('14 players: both factions, bounded copies, balanced classes across many deals',()=>{for(const faction of ['Horde','Alliance'])for(let run=0;run<25;run++){const g=E.create(names(14),pool(faction),50,1,Math.random,{copies:2,variety:true,balanced:true});verify(g);assert.equal(new Set(g.players.flatMap(p=>p.hand.map(c=>c.cls))).size,9)}});
test('one-copy variety and class-capacity errors',()=>{const p=pool('Horde');verify(E.create(names(7),p,50,0,Math.random,{copies:1,variety:true,balanced:true}));assert.throws(()=>E.create(names(14),p,50,1,Math.random,{copies:1,variety:true}),/Enable at least/);assert.throws(()=>E.create(names(2),p.filter(c=>['Warrior','Shaman'].includes(c.cls)),50,1,Math.random,{copies:2,variety:true}),/different classes/)});
test('three DPS allowed; role composition does not block restricted pools',()=>{const p=pool('Horde').filter(c=>!c.flex);const g=E.create(names(5),p,50,0,Math.random,{copies:2,variety:true,balanced:true});verify(g);assert.ok(g.players.every(p=>p.hand.every(c=>!c.flex)))});
test('valid swaps preserve class variety and copy counts; invalid swaps are atomic',()=>{for(let run=0;run<8;run++){const g=E.create(names(14),pool('Horde'),50,2,Math.random,{copies:2,variety:true,balanced:true});E.lockDefense(g,g.players.map(()=>[0,0,0]));while(g.phase==='steal'){const a=E.current(g),valid=[],invalid=[];g.players.forEach((p,i)=>{if(i!==a)p.hand.forEach((c,j)=>g.players[a].hand.forEach((off,k)=>(E.canSwap(g,i,j,k)?valid:invalid).push([i,j,k]))) });if(invalid.length){const before=JSON.stringify(g);assert.throws(()=>E.contest(g,...invalid[0],0));assert.equal(JSON.stringify(g),before)}if(valid.length){let rolls=[.99,0];E.contest(g,...valid[0],0,()=>rolls.shift())}else E.pass(g);verify(g)}}});

function seeded(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}}
test('13-player balanced deals represent every class and equalize totals within capacity',()=>{
 for(const faction of ['Horde','Alliance'])for(let seed=1;seed<=60;seed++){
  const cards=pool(faction),g=E.create(names(13),cards,50,1,seeded(seed),{copies:2,variety:true,balanced:true});verify(g);
  const totals={},combos={};for(const c of g.players.flatMap(p=>p.hand)){totals[c.cls]=(totals[c.cls]||0)+1;combos[c.key]=(combos[c.key]||0)+1}
  const classes=[...new Set(cards.map(c=>c.cls))];assert.equal(Object.keys(totals).length,classes.length);
  for(const cls of classes){const options=cards.filter(c=>c.cls===cls),capacity=Math.min(13,options.length*2);
   for(const other of classes)if(totals[cls]<capacity)assert.ok(totals[other]<=totals[cls]+1,`Imbalanced ${cls} vs ${other}`);
   if(options.some(c=>combos[c.key]===2))assert.ok(options.every(c=>combos[c.key]>=1),'Repeated combo before class alternatives used');
  }
 }
});
test('balanced small and restricted pools respect availability without inventing classes',()=>{
 for(const n of [1,2,3,7])for(const copies of [1,2]){const g=E.create(names(n),pool('Horde'),50,0,seeded(n),{copies,variety:true,balanced:true});verify(g);if(n>=3)assert.equal(new Set(g.players.flatMap(p=>p.hand.map(c=>c.cls))).size,9)}
 const restricted=pool('Horde').filter(c=>['Warrior','Druid','Shaman'].includes(c.cls));const g=E.create(names(4),restricted,0,0,seeded(5),{copies:2,variety:true,balanced:true});verify(g);assert.ok(g.players.every(p=>p.hand.every(c=>['Warrior','Druid','Shaman'].includes(c.cls))));
});
