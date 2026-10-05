const test=require('node:test'),assert=require('node:assert/strict'),E=require('../js/deal-engine.js');
const pool=Array.from({length:30},(_,i)=>({key:String(i),race:'Race '+i,cls:'Warrior'}));
const make=(n=3,attempts=1)=>E.create(Array.from({length:n},(_,i)=>'Player '+i),pool,50,attempts);
const invariant=g=>{const cards=g.players.flatMap(p=>p.hand);assert.equal(cards.length,g.players.length*3);assert.equal(new Set(cards.map(c=>c.key)).size,cards.length);g.players.forEach(p=>assert.equal(p.hand.length,3))};
test('arbitrary player counts deal unique reserved cards',()=>{for(let n=1;n<=10;n++){const g=make(n);invariant(g);assert.equal(g.phase,n===1?'choose':'defense')}});
test('pool validation and duplicate player names',()=>{assert.throws(()=>make(11),/Enable at least/);assert.throws(()=>E.create(['a','A'],pool,50,1),/different name/);assert.throws(()=>E.create(['a'],[...pool,pool[0]],50,1),/duplicates/)});
test('zero attempts skips defense and stealing',()=>assert.equal(make(5,0).phase,'choose'));
test('defense budget locks atomically',()=>{const g=make();assert.throws(()=>E.lockDefense(g,[[51,0,0],[0,0,0],[0,0,0]]));assert.equal(g.phase,'defense');assert.equal(g.players[0].reserve,50);E.lockDefense(g,[[50,0,0],[10,10,10],[0,0,0]]);assert.deepEqual(g.players.map(p=>p.reserve),[0,20,50]);assert.throws(()=>E.lockDefense(g,[[0,0,0],[0,0,0],[0,0,0]]))});
test('successful swap spends attack points, retains slot defense, protects stolen card',()=>{const g=make(),a=E.current(g),d=(a+1)%3;const alloc=g.players.map(()=>[10,0,0]);E.lockDefense(g,alloc);const offered=g.players[a].hand[0].key,target=g.players[d].hand[0].key;let draws=[.99,0];const r=E.contest(g,d,0,0,15,()=>draws.shift());assert.equal(r.won,true);assert.equal(g.players[a].reserve,25);assert.equal(g.players[a].hand[0].key,target);assert.equal(g.players[d].hand[0].key,offered);assert.equal(g.players[a].hand[0].protected,true);assert.equal(g.players[d].defense[0],10);invariant(g)});
test('ties and losses favor owner; attacker still pays',()=>{const g=make(),a=E.current(g),d=(a+1)%3;const alloc=g.players.map(()=>[10,0,0]);E.lockDefense(g,alloc);const before=JSON.stringify(g.players.map(p=>p.hand));const r=E.contest(g,d,0,1,10,()=>.4);assert.equal(r.won,false);assert.equal(g.players[a].reserve,30);assert.equal(JSON.stringify(g.players.map(p=>p.hand)),before)});
test('invalid actions cannot mutate state',()=>{const g=make(),a=E.current(g),d=(a+1)%3;E.lockDefense(g,g.players.map(()=>[0,0,0]));for(const args of [[a,0,0,0],[d,0,0,51],[d,0,0,-1],[d,0,0,1.2],[d,4,0,0]]){const before=JSON.stringify(g);assert.throws(()=>E.contest(g,...args));assert.equal(JSON.stringify(g),before)}g.players[d].hand[0].protected=true;assert.throws(()=>E.contest(g,d,0,0,0),/Protected/);g.players[a].hand[1].protected=true;assert.throws(()=>E.contest(g,d,1,1,0),/Protected/)});
test('equal turns, passing, lock order, and phase enforcement',()=>{const g=make(4,2);E.lockDefense(g,g.players.map(()=>[0,0,0]));const count=[0,0,0,0];for(let i=0;i<8;i++){count[E.current(g)]++;E.pass(g)}assert.deepEqual(count,[2,2,2,2]);assert.equal(g.phase,'choose');assert.throws(()=>E.pass(g));for(const i of [3,1,0,2])E.choose(g,i,2);assert.equal(g.phase,'done');assert.throws(()=>E.choose(g,0,1));invariant(g)});
test('many games preserve uniqueness and point budgets through contests',()=>{for(let n=2;n<=9;n++)for(let run=0;run<20;run++){const g=make(n,3);E.lockDefense(g,g.players.map(()=>[10,15,5]));while(g.phase==='steal'){const a=E.current(g),offered=g.players[a].hand.findIndex(c=>!c.protected);let target;g.players.forEach((p,i)=>{if(i!==a)p.hand.forEach((c,j)=>{if(!c.protected)target=[i,j]})});if(offered<0||!target)E.pass(g);else E.contest(g,...target,offered,Math.min(5,g.players[a].reserve));invariant(g);g.players.forEach(p=>assert.ok(p.reserve>=0))}}});

test('version-one saved deal resumes without class-variety migration',()=>{
 const g=make(2);g.version=1;delete g.copies;delete g.variety;delete g.balanced;
 for(const p of g.players)for(const c of p.hand)delete c.id;
 const saved=JSON.parse(JSON.stringify(g));E.lockDefense(saved,saved.players.map(()=>[0,0,0]));
 E.contest(saved,1-E.current(saved),0,0,0,()=>.5);E.pass(saved);
 saved.players.forEach((p,i)=>E.choose(saved,i,0));assert.equal(saved.phase,'done');invariant(saved);
});
test('rule validation retains API client-error status',()=>{
 assert.throws(()=>E.create(['A','a'],pool,50,1),e=>e.statusCode===400);
 const g=make();assert.throws(()=>E.choose(g,0,0),e=>e.statusCode===400);
});
test('CSV exports legacy picks and locked Guild Selection heroes safely',()=>{
 const card={race:'Orc',cls:'Warrior'};
 for(const player of [{name:'=HYPERLINK("bad")',hand:[card],choice:0},{name:'=HYPERLINK("bad")',hand:[],choice:null,lockedCard:card}]){
  const g={faction:'Horde',players:[player],...(player.lockedCard?{selection:{phase:'done'}}:{})};
  assert.equal(E.rosterCsv(g),'"Player","Faction","Race","Class"\r\n"\'=HYPERLINK(""bad"")","Horde","Orc","Warrior"');
 }
 assert.throws(()=>E.rosterCsv({faction:'Horde',selection:{},players:[{name:'A',lockedCard:null}]}),/Finish every selection/);
});
