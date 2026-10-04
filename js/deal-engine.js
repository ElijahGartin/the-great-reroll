/* Pure rules for Deal Everyone. No dependencies on the turn-based draft. */
(function(root){
'use strict';
function check(ok,message){if(!ok)throw Object.assign(Error(message),{statusCode:400})}
function integer(n,min,max){return Number.isInteger(n)&&n>=min&&n<=max}
function shuffle(items,rng=Math.random){const out=[...items];for(let i=out.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[out[i],out[j]]=[out[j],out[i]]}return out}
function create(names,pool,budget,attempts,rng=Math.random){
 check(names.length>0&&names.every(n=>typeof n==='string'&&n.trim()),'Give every player a name.');
 check(new Set(names.map(n=>n.trim().toLowerCase())).size===names.length,'Use a different name for each player.');
 check(integer(budget,0,1000)&&integer(attempts,0,5),'Use 0–1000 bonus points and 0–5 steal attempts.');
 check(new Set(pool.map(c=>c.key)).size===pool.length,'The eligible pool contains duplicates.');
 check(pool.length>=names.length*3,`Enable at least ${names.length*3} combinations for ${names.length} players (currently ${pool.length}).`);
 const cards=shuffle(pool,rng).slice(0,names.length*3).map(c=>({...c,protected:false}));
 return {version:1,phase:attempts&&names.length>1?'defense':'choose',budget,attempts,players:names.map((name,i)=>({name:name.trim(),hand:cards.slice(i*3,i*3+3),defense:[0,0,0],reserve:budget,choice:null})),order:shuffle(names.map((_,i)=>i),rng),turn:0,log:[]};
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
const api={create,lockDefense,current,pass,contest,choose};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GR_DEAL_ENGINE=api;
})(typeof window!=='undefined'?window:globalThis);
