/* Pure rules for Deal Everyone. No dependencies on the turn-based draft. */
(function(root){
'use strict';
function check(ok,message){if(!ok)throw Object.assign(Error(message),{statusCode:400})}
function integer(n,min,max){return Number.isInteger(n)&&n>=min&&n<=max}
function shuffle(items,rng=Math.random){const out=[...items];for(let i=out.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[out[i],out[j]]=[out[j],out[i]]}return out}
// Min-cost flow allocates classes across the entire table before cards are assigned.
// Balance class totals first; hand role preferences are secondary soft costs.
// Convex class costs spread picks across enabled classes within their copy limits.
function buildHands(pool,n,copies,balanced,rng){
 const classes=shuffle([...new Set(pool.map(c=>c.cls))],rng),graph=[];
 const node=()=>{graph.push([]);return graph.length-1},source=node(),sink=node();
 function edge(a,b,cap,cost=0){const f={to:b,cap,cost,rev:graph[b].length},r={to:a,cap:0,cost:-cost,rev:graph[a].length};graph[a].push(f);graph[b].push(r);return f}
 const slots=Array.from({length:n},()=>{const p=node(),dps=node(),flex=node();edge(p,sink,3);edge(dps,p,2);edge(dps,p,1,balanced?1:0);edge(flex,p,1);edge(flex,p,2,balanced?5:0);return{dps,flex}}),links=[];
 for(const cls of classes){const cards=pool.filter(c=>c.cls===cls),c=node();const capacity=Math.min(n,cards.length*copies);if(balanced){for(let k=0;k<capacity;k++)edge(source,c,1,k*(n*20+1))}else edge(source,c,capacity);for(const i of shuffle(slots.map((_,i)=>i),rng)){const e=edge(c,slots[i][cards[0].flex?'flex':'dps'],1);links.push({cls,i,e})}}
 let flow=0;
 while(flow<n*3){
  const dist=graph.map(()=>Infinity),prev=graph.map(()=>null),queue=[source],queued=new Set(queue);dist[source]=0;
  for(let at=0;at<queue.length;at++){const u=queue[at];queued.delete(u);graph[u].forEach((e,j)=>{if(e.cap&&dist[e.to]>dist[u]+e.cost){dist[e.to]=dist[u]+e.cost;prev[e.to]=[u,j];if(!queued.has(e.to)){queue.push(e.to);queued.add(e.to)}}})}
  if(!prev[sink])break;
  for(let v=sink;v!==source;){const [u,j]=prev[v],e=graph[u][j];e.cap--;graph[v][e.rev].cap++;v=u}flow++;
 }
 check(flow===n*3,'The selected pool cannot give every player three different classes. Enable more combinations across different classes, increase copies, or reduce players.');
 const hands=Array.from({length:n},()=>[]);
 for(const cls of classes){const dealtKeys=new Set();let deck=shuffle(pool.filter(c=>c.cls===cls).flatMap(c=>Array.from({length:copies},(_,i)=>({...c,id:c.key+'#'+i,protected:false}))),rng);for(const link of shuffle(links.filter(l=>l.cls===cls&&l.e.cap===0),rng)){const hand=hands[link.i];const eligible=balanced&&deck.some(c=>!dealtKeys.has(c.key))?deck.filter(c=>!dealtKeys.has(c.key)):deck;const chosen=eligible.find(c=>!hand.some(v=>v.race===c.race))||eligible[0];const idx=deck.indexOf(chosen);dealtKeys.add(chosen.key);hand.push(deck.splice(idx,1)[0])}}
 return shuffle(hands.map(h=>shuffle(h,rng)),rng);
}
function canSwap(game,target,slot,offered){
 const a=game.players[current(game)],d=game.players[target];
 if(!d||a===d||!integer(slot,0,2)||!integer(offered,0,2))return false;
 const incoming=d.hand[slot],outgoing=a.hand[offered];
 if(incoming.protected||outgoing.protected||incoming.key===outgoing.key)return false;
 const field=game.variety?'cls':'key';
 return !a.hand.some((c,i)=>i!==offered&&c[field]===incoming[field])&&!d.hand.some((c,i)=>i!==slot&&c[field]===outgoing[field]);
}
function create(names,pool,budget,attempts,rng=Math.random,options={}){
 const copies=options.copies??1,variety=!!options.variety,balanced=!!options.balanced;
 check(integer(copies,1,2),'Choose one or two copies per combination.');
 check(names.length>0&&names.every(n=>typeof n==='string'&&n.trim()),'Give every player a name.');
 check(new Set(names.map(n=>n.trim().toLowerCase())).size===names.length,'Use a different name for each player.');
 check(integer(budget,0,1000)&&integer(attempts,0,5),'Use 0–1000 bonus points and 0–5 steal attempts.');
 check(new Set(pool.map(c=>c.key)).size===pool.length,'The eligible pool contains duplicates.');
 check(pool.length*copies>=names.length*3,`Enable at least ${Math.ceil(names.length*3/copies)} combinations for ${names.length} players (currently ${pool.length*copies} cards at ${copies} copies).`);
 const cards=shuffle(pool,rng).slice(0,names.length*3).map(c=>({...c,id:c.key+'#0',protected:false}));
 const hands=variety?buildHands(pool,names.length,copies,balanced,rng):names.map((_,i)=>cards.slice(i*3,i*3+3));
 check(variety||copies===1,'Multiple copies require class variety.');
 return {version:2,copies,variety,balanced,phase:attempts&&names.length>1?'defense':'choose',budget,attempts,players:names.map((name,i)=>({name:name.trim(),hand:hands[i],defense:[0,0,0],reserve:budget,choice:null})),order:shuffle(names.map((_,i)=>i),rng),turn:0,log:[]};
}
function lockDefense(game,allocations){
 check(game.phase==='defense','Defense is already locked.');
 check(allocations.length===game.players.length,'Set defense for every player.');
 allocations.forEach(a=>check(a.length===3&&a.every(n=>integer(n,0,game.budget))&&a.reduce((s,n)=>s+n,0)<=game.budget,'Defense must use whole points and stay within each player’s budget.'));
 game.players.forEach((p,i)=>{p.defense=[...allocations[i]];p.reserve=game.budget-p.defense.reduce((s,n)=>s+n,0)});game.phase='steal';
}
function current(game){return game.order[game.turn%game.order.length]}
function advance(game){game.turn++;if(game.turn>=game.order.length*game.attempts)game.phase='choose'}
function pass(game){check(game.phase==='steal','The steal round is not active.');game.log.push(`${game.players[current(game)].name} passed.`);advance(game)}
function contest(game,target,slot,offered,bonus,rng=Math.random){
 check(game.phase==='steal','The steal round is not active.');
 const attacker=current(game),a=game.players[attacker],d=game.players[target];
 check(d&&target!==attacker,'Choose another player’s card.');
 check(integer(slot,0,2)&&integer(offered,0,2),'Choose the target card and your offered card.');
 check(!d.hand[slot].protected&&!a.hand[offered].protected,'Protected cards cannot be stolen or offered.');
 check(canSwap(game,target,slot,offered),'This swap would duplicate a class or combination in a hand. Choose a different pair.');
 check(integer(bonus,0,a.reserve),'Attack points must stay within your remaining reserve.');
 const attackRoll=1+Math.floor(rng()*100),defenseRoll=1+Math.floor(rng()*100);
 const defense=d.defense[slot],won=attackRoll+bonus>defenseRoll+defense;
 const targetCard=d.hand[slot],offerCard=a.hand[offered];
 a.reserve-=bonus;
 if(won){a.hand[offered]=targetCard;d.hand[slot]=offerCard;targetCard.protected=true}
 const result={attacker:a.name,defender:d.name,attackRoll,defenseRoll,bonus,defense,won,target:targetCard.race+' '+targetCard.cls,offered:offerCard.race+' '+offerCard.cls};
 game.log.push(`${a.name}: ${attackRoll} + ${bonus} = ${attackRoll+bonus}; ${d.name}: ${defenseRoll} + ${defense} = ${defenseRoll+defense}. ${won?'SWAP: '+result.target+' ↔ '+result.offered:'Defender keeps '+result.target+'.'}`);
 game.lastResult=result;advance(game);return result;
}
function choose(game,player,slot){check(game.phase==='choose','Finish the steal round before choosing.');check(game.players[player]&&integer(slot,0,2),'Choose one of your three cards.');check(game.players[player].choice===null,'This player has already locked in.');game.players[player].choice=slot;if(game.players.every(p=>p.choice!==null))game.phase='done'}
function rosterCsv(game){
 const rows=[['Player','Faction','Race','Class'],...game.players.map(p=>{const card=game.selection?p.lockedCard:p.hand[p.choice];check(card,'Finish every selection before exporting.');return[p.name,game.faction,card.race,card.cls]})];
 return rows.map(row=>row.map(value=>{const text=String(value),safe=/^[=+@\-\t\r]/.test(text)?"'"+text:text;return '"'+safe.replaceAll('"','""')+'"'}).join(',')).join('\r\n');
}
const api={rosterCsv,create,canSwap,lockDefense,current,pass,contest,choose};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GR_DEAL_ENGINE=api;
})(typeof window!=='undefined'?window:globalThis);
