/* Guild selection round. Pure state transitions; each physical card has one owner. */
(function(root){
'use strict';
const check=(ok,msg)=>{if(!ok)throw Error(msg)},whole=(n,max)=>Number.isInteger(n)&&n>=0&&n<=max;
const shuffle=(a,rng)=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const die=rng=>1+Math.floor(rng()*100),state=g=>{check(g.selection,'Enter the selection round first.');return g.selection};
function start(g,pool){
 check(!g.selection,'Selection already started.');
 check(g.phase==='reveal'&&g.revealed.every(Boolean),'Reveal every hand first.');
 const held=new Set(g.players.flatMap(p=>p.hand.map(c=>c.id)));
 const all=pool.flatMap(c=>Array.from({length:g.copies},(_,i)=>({...c,id:c.key+'#'+i,protected:false})));
 g.selection={phase:'order',available:all.filter(c=>!held.has(c.id)),allIds:all.map(c=>c.id),order:[],pending:g.players.map((_,i)=>i),scores:g.players.map(()=>[]),active:null,claim:null,result:null,returned:[],log:[],attackCap:50,defenseCap:75};
 g.players.forEach(p=>{p.points=g.budget;p.rerolled=false;p.lockedCard=null});g.phase='selection';return g.selection;
}
function compare(s,a,b){for(let i=0;i<Math.max(s.scores[a].length,s.scores[b].length);i++){const d=(s.scores[b][i]||0)-(s.scores[a][i]||0);if(d)return d}return 0}
function rollOrder(g,i,rng=Math.random){const s=state(g);check(s.phase==='order'&&s.pending.includes(i),'This player is not waiting to roll.');const n=die(rng);s.scores[i].push(n);s.pending=s.pending.filter(v=>v!==i);
 if(!s.pending.length){s.order=g.players.map((_,j)=>j).sort((a,b)=>compare(s,a,b));const ties=new Set();for(let j=1;j<s.order.length;j++)if(compare(s,s.order[j-1],s.order[j])===0){ties.add(s.order[j-1]);ties.add(s.order[j])}s.pending=[...ties];if(!s.pending.length)activate(g)}return n;
}
function activate(g){const s=state(g);s.active=s.order.find(i=>!g.players[i].lockedCard)??null;s.phase=s.active===null?'done':'turn';s.claim=null}
function replacements(g,slots,rng=Math.random){const s=state(g),p=g.players[s.active];check(s.phase==='turn'&&!p.rerolled,'Your reroll is no longer available.');check(Array.isArray(slots)&&slots.length>0&&slots.length<=3&&new Set(slots).size===slots.length&&slots.every(i=>whole(i,2)),'Select one to three cards to reroll.');const rejected=new Set(slots.map(i=>p.hand[i].key)),used=new Set(p.hand.filter((_,i)=>!slots.includes(i)).map(c=>c.cls));const deck=shuffle(s.available.filter(c=>!rejected.has(c.key)&&!used.has(c.cls)),rng),out=[];
 function search(at){if(out.length===slots.length)return true;for(let i=at;i<deck.length;i++){const c=deck[i];if(used.has(c.cls))continue;used.add(c.cls);out.push(c);if(search(i+1))return true;out.pop();used.delete(c.cls)}return false}return search(0)?out:null;
}
function canReroll(g,slots){try{return!!replacements(g,slots,()=>.5)}catch{return false}}
function reroll(g,slots,rng=Math.random){const s=state(g),p=g.players[s.active],draw=replacements(g,slots,rng);check(draw,'Not enough valid replacements. Keep more cards or keep your hand.');const discards=slots.map(i=>p.hand[i]),ids=new Set(draw.map(c=>c.id));s.available=s.available.filter(c=>!ids.has(c.id));slots.forEach((j,i)=>p.hand[j]=draw[i]);s.available.push(...discards);s.returned=discards.map(c=>c.id);p.rerolled=true;s.log.push(p.name+' rerolled '+slots.length+' card(s).');return draw}
function offers(g,i){const s=state(g),c=s.claim;if(!c||i===c.owner||!g.players[i]||g.players[i].lockedCard)return[];const p=g.players[i],owner=g.players[c.owner],card=owner.hand[c.slot];if(p.hand.some(v=>v.key===card.key))return[];return p.hand.map((v,j)=>({v,j})).filter(({v})=>!owner.hand.some((other,k)=>k!==c.slot&&other.cls===v.cls)).map(({j})=>j)}
function nominate(g,slot){const s=state(g);check(s.phase==='turn'&&whole(slot,2),'Choose a card on your turn.');s.claim={owner:s.active,slot,responses:{},defense:0};s.claim.eligible=g.players.map((_,i)=>i).filter(i=>offers(g,i).length);s.phase='bids';}
function respond(g,i,bid,offer){const s=state(g),c=s.claim;check(s.phase==='bids'&&c.eligible.includes(i)&&!Object.hasOwn(c.responses,i),'This player cannot submit again.');if(bid===null)c.responses[i]={pass:true};else{check(whole(bid,Math.min(s.attackCap,g.players[i].points)),'Attack must be a whole number within your remaining points and the attack cap.');check(offers(g,i).includes(offer),'Choose an eligible card to offer in exchange.');c.responses[i]={pass:false,bid,offer}}}
function revealBids(g){const s=state(g),c=s.claim;check(s.phase==='bids'&&c.eligible.every(i=>Object.hasOwn(c.responses,i)),'Every eligible player must submit a bid or pass.');const bids=c.eligible.filter(i=>!c.responses[i].pass);for(const i of bids)g.players[i].points-=c.responses[i].bid;c.attackers=bids;
 if(!bids.length){s.result={winner:c.owner,card:{...g.players[c.owner].hand[c.slot]},rows:[],uncontested:true};finish(g,c.owner);s.phase='result'}else s.phase='defense';
}
function lock(g,i,card){const s=state(g),p=g.players[i],released=p.hand.filter(c=>c.id!==card.id);s.available.push(...released);s.returned.push(...released.map(c=>c.id));p.hand=[card];p.lockedCard=card;p.choice=0;}
function finish(g,winner){const s=state(g),c=s.claim,owner=g.players[c.owner],target=owner.hand[c.slot];s.returned=[];if(winner===c.owner)lock(g,winner,target);else{const attacker=g.players[winner],offered=attacker.hand[c.responses[winner].offer];attacker.hand=attacker.hand.filter(v=>v.id!==offered.id);owner.hand[c.slot]=offered;lock(g,winner,target)}s.log.push(g.players[winner].name+' locked '+target.race+' '+target.cls+(winner!==c.owner?' after challenging '+owner.name:'.'));}
function resolve(g,rows){const s=state(g),c=s.claim,max=Math.max(...rows.map(r=>r.total)),top=rows.filter(r=>r.total===max).map(r=>r.player);s.result.rounds.push(rows);if(top.includes(c.owner)){s.result.winner=c.owner;finish(g,c.owner);s.phase='result'}else if(top.length===1){s.result.winner=top[0];finish(g,top[0]);s.phase='result'}else{s.result.tied=top;s.phase='tiebreak'}}
// Commit all bonuses before revealing any individual dice. Each pending player rolls once.
function beginDefense(g,amount){const s=state(g),c=s.claim;check(s.phase==='defense','Reveal the bids before defending.');check(whole(amount,Math.min(s.defenseCap,g.players[c.owner].points)),'Defense must be a whole number within your remaining points and the defense cap.');g.players[c.owner].points-=amount;c.defense=amount;s.result={card:{...g.players[c.owner].hand[c.slot]},rounds:[],winner:null,uncontested:false};s.rolling={pending:[c.owner,...c.attackers],rows:[],tie:false};s.phase='rolling';}
function beginTiebreak(g){const s=state(g);check(s.phase==='tiebreak','No tied challengers to reroll.');s.rolling={pending:[...s.result.tied],rows:[],tie:true};s.phase='rolling';}
function rollContest(g,i,rng=Math.random){const s=state(g),c=s.claim;check(s.phase==='rolling'&&s.rolling.pending[0]===i,'Wait for your turn to roll.');const roll=die(rng),bonus=s.rolling.tie?0:i===c.owner?c.defense:c.responses[i].bid,row={player:i,roll,bonus,total:roll+bonus};s.rolling.rows.push(row);s.rolling.pending.shift();if(!s.rolling.pending.length)resolve(g,[...s.rolling.rows]);return row;}
function defend(g,amount,rng=Math.random){beginDefense(g,amount);const s=state(g);while(s.phase==='rolling')rollContest(g,s.rolling.pending[0],rng);return [...s.rolling.rows];}
function tiebreak(g,rng=Math.random){beginTiebreak(g);const s=state(g);while(s.phase==='rolling')rollContest(g,s.rolling.pending[0],rng);return [...s.rolling.rows];}
function next(g){const s=state(g);check(s.phase==='result','Resolve this claim first.');activate(g)}
const api={start,rollOrder,canReroll,reroll,offers,nominate,respond,revealBids,beginDefense,beginTiebreak,rollContest,defend,tiebreak,next};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GR_SELECTION_ENGINE=api;
})(typeof window!=='undefined'?window:globalThis);
