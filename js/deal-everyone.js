/* Host-operated, shared-screen Deal Everyone mode. */
(()=>{
'use strict';
const E=window.GR_DEAL_ENGINE,D=window.GR_CHARACTER_DATA,esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const entry=document.createElement('div');entry.id='dealEntry';entry.innerHTML='<div><strong>DEAL EVERYONE</strong><p>Three unique heroes each. Roll for order, reroll your hand, and claim or challenge your favorite.</p></div><button type="button" class="wt-btn wt-btn-primary" id="openDeal">DEAL EVERYONE →</button>';
document.querySelector('[data-rr-step="1"]').appendChild(entry);
const dialog=document.createElement('dialog');dialog.id='dealDialog';dialog.setAttribute('aria-labelledby','dealTitle');dialog.innerHTML='<div class="deal-head"><div><div class="deal-kicker">THE GREAT REROLL · SHARED SCREEN</div><h2 id="dealTitle">Deal Everyone</h2></div><button type="button" data-action="close" aria-label="Close Deal Everyone">Close</button></div><p id="dealError" role="alert"></p><div id="dealContent"></div>';document.body.appendChild(dialog);
const content=dialog.querySelector('#dealContent'),error=dialog.querySelector('#dealError');
let config={names:['Player 1','Player 2','Player 3','Player 4'],faction:'Horde',budget:100,attempts:0,copies:2,balanced:true},game=null,allocations=[],pendingResult=null,eligibilityFaction='Horde';
let spinning=false,spinAnimations=[],selectionBusy=false;
const pools={Horde:D.HORDE,Alliance:D.ALLIANCE},enabled={};
for(const faction of Object.keys(pools))enabled[faction]=new Set(Object.entries(pools[faction]).flatMap(([race,classes])=>classes.map(cls=>race+'|'+cls)));
function pool(faction){return Object.entries(pools[faction]).flatMap(([race,classes])=>classes.filter(cls=>enabled[faction].has(race+'|'+cls)).map(cls=>({race,cls,key:race+'|'+cls,faction,flex:(D.CLASS_SPECS[cls]||[]).some(spec=>/tank|heal/i.test(spec[1]))})))}
function action(label,name,extra='',primary=false){return `<button type="button" data-action="${name}" ${extra} class="${primary?'deal-primary':''}">${label}</button>`}
function fail(fn){error.textContent='';try{fn()}catch(e){error.textContent=e.message;error.scrollIntoView({block:'nearest'})}}
function selected(value,expected){return value===expected?' selected':''}
function rules(){return '<details><summary>How this game works</summary><p>Everyone receives three different classes. Balanced deals spread classes across the table within the enabled pool and copy limits. Reveal each hand, then enter the selection round.</p><p>Each player rolls D100 for order; ties reroll. On your turn, keep your hand or reroll selected cards once, then claim a character. Unresolved players may submit a sealed attack bid and offer a card in exchange, or pass. After every response, attack bids are revealed and spent. The owner sees the bids before choosing defense. Roll D100 plus the committed bonus: highest wins, and the owner wins ties. Tied top challengers reroll for free. All attack and defense points are spent even on a loss.</p><p>Each player starts with the configured shared point budget. Attack cap: 50; defense cap: 75, both limited by points remaining. A challenger who wins locks the character and gives their offered card to the owner, who keeps their turn. Unused cards return to the pool whenever anyone locks a hero. A locked player is finished and cannot challenge again.</p><p>Shared-screen mode: the host collects bids privately. Masked bids are a presentation feature, not secure multiplayer secrecy. Refreshing clears this game.</p></details>'}
function capacity(){const factions=config.faction==='Either'?['Horde','Alliance']:[config.faction];return factions.map(f=>`${f}: ${pool(f).length} combinations × ${config.copies} copies = ${pool(f).length*config.copies} cards / ${config.names.length*3} needed`).join(' · ')}
function renderPool(){const f=config.faction==='Either'?eligibilityFaction:config.faction;return `<details open><summary>Eligible character pool</summary>${config.faction==='Either'?`<div class="deal-controls">${action('Horde','poolFaction','data-faction="Horde"')}${action('Alliance','poolFaction','data-faction="Alliance"')}</div>`:''}<p class="deal-muted">${f} · choose which combinations can be dealt.</p><div class="deal-controls">${action('Select all','all')}${action('Clear all','none')}</div>${Object.entries(pools[f]).map(([race,classes])=>`<div class="deal-pool-race"><strong>${esc(race)}</strong>${classes.map(cls=>`<label><input type="checkbox" data-pool="${esc(race+'|'+cls)}" data-faction="${f}" ${enabled[f].has(race+'|'+cls)?'checked':''}>${esc(cls)}</label>`).join('')}</div>`).join('')}</details>`}
function setup(){const selectedGroup=content.querySelector('#dealSavedGroups')?.dataset.groupId||'';content.innerHTML=`<h3>Deal the whole table</h3><p>Choose your players and eligible pool. Every player gets three hero cards from different classes.</p><div class="deal-controls"><label>Players<input id="dealCount" type="number" min="1" max="40" step="1" value="${config.names.length}"></label><label>Faction<select id="dealFaction"><option${selected(config.faction,'Horde')}>Horde</option><option${selected(config.faction,'Alliance')}>Alliance</option><option${selected(config.faction,'Either')}>Either</option></select></label><label>Copies per combination<select id="dealCopies"><option value="1"${selected(config.copies,1)}>1 — unique across the table</option><option value="2"${selected(config.copies,2)}>2 — limited duplicates</option></select></label><label>Hand composition<select id="dealBalanced"><option value="on"${selected(config.balanced,true)}>Balanced across the table</option><option value="off"${selected(config.balanced,false)}>Random, different classes</option></select></label><label>Bonus points per player<input id="dealBudget" type="number" min="0" max="1000" step="1" value="${config.budget}"></label></div><p class="deal-muted">Attack cap: 50 · Defense cap: 75 · one shared point budget. Either randomly chooses one faction; both pools must have enough cards.</p><div id="dealSavedGroups"></div><p class="deal-muted">Every hand has three different classes. Balanced deals spread classes across the whole table and favor different race/class combinations before repeats. Two copies allows duplicate final characters.</p><div class="deal-names">${config.names.map((name,i)=>`<label>Player ${i+1}<input data-name="${i}" maxlength="32" value="${esc(name)}"></label>`).join('')}</div><div id="dealCapacity" class="deal-capacity">${capacity()}</div>${renderPool()}${rules()}<div class="deal-actions">${action('START THE REVEALS','deal','',true)}</div>`;const groups=content.querySelector('#dealSavedGroups');groups.dataset.groupId=selectedGroup;window.GR_PLAYER_GROUPS.mount(groups,()=>config.names,names=>{config.names=names;setup()})}
function hand(p,i){return `<section class="deal-hand"><h3>${esc(p.name)}<small>${game.phase==='defense'?`<span data-reserve="${i}">${game.budget-allocations[i].reduce((a,b)=>a+b,0)}</span> attack points left`:p.choice!==null?'LOCKED IN':p.reserve+' attack points left'}</small></h3><div class="deal-cards">${p.hand.map((card,j)=>{const art=D.HERO_ART[card.faction+'|'+card.race+'|'+card.cls]||D.GREAT_REROLL_CLASS_ICONS[card.cls];return `<article class="deal-card ${p.choice===j?'is-chosen':p.choice!==null?'is-rejected':''}" style="--deal-class:${D.GREAT_REROLL_CLASS_COLORS[card.cls]||'#d7b56d'}"><div class="deal-card-art"><img src="${esc(art)}" alt="${esc(card.race+' '+card.cls)}" loading="lazy"><span class="deal-class-icon" title="${esc(card.cls)}"><img src="${esc(D.GREAT_REROLL_CLASS_ICONS[card.cls])}" alt="" aria-hidden="true"></span></div><div class="deal-card-copy"><b>${esc(card.race)} ${esc(card.cls)}</b><small>${card.flex?'Tank/healer option':'DPS-focused'}</small><small>${card.protected?'🔒 Protected':game.phase==='defense'?'Assign defense':'Defense +'+p.defense[j]}</small>${game.phase==='defense'?`<label>Defense points<input type="number" min="0" max="${game.budget}" step="1" data-defense="${i}:${j}" value="${allocations[i][j]}"></label>`:''}${game.phase==='choose'&&!pendingResult&&p.choice===null?action('Lock this hero','choose',`data-player="${i}" data-slot="${j}"`):''}</div></article>`}).join('')}</div></section>`}
// Compact ownership summary uses current hands, so successful swaps stay in sync.
function ownershipSummary(players=game.players,final=false){
 const rows=players.map(p=>{
  const cards=final?[p.hand[p.choice]]:p.hand;
  return `<tr><th scope="row">${esc(p.name)}</th><td><div class="deal-summary-heroes">${cards.map(card=>{
   const chosen=p.choice!==null&&p.hand[p.choice]===card;
   const art=D.HERO_ART[card.faction+'|'+card.race+'|'+card.cls]||D.GREAT_REROLL_CLASS_ICONS[card.cls];
   return `<div class="deal-summary-hero ${chosen?'is-locked':''}" style="--deal-class:${D.GREAT_REROLL_CLASS_COLORS[card.cls]||'#d7b56d'}"><img src="${esc(art)}" alt="" loading="lazy"><span><b>${esc(card.race+' '+card.cls)}</b>${chosen?'<small>✓ Locked hero</small>':''}</span></div>`;
  }).join('')}</div></td></tr>`;
 }).join('');
 return `<section class="deal-summary" aria-label="${final?'Final roster':'Who got who'}"><table><caption>${final?'Final roster':'Who got who'}</caption><thead><tr><th scope="col">Player</th><th scope="col">${final?'Locked hero':'Current characters'}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
function offerOptions(target,slot){return game.players[E.current(game)].hand.map((c,j)=>E.canSwap(game,target,slot,j)?`<option value="${j}">${esc(c.race+' '+c.cls)}</option>`:'').join('')}
function turn(){
 if(game.phase!=='steal'||pendingResult)return '';
 const a=E.current(game),p=game.players[a],targets=[];
 game.players.forEach((other,i)=>{if(i!==a)other.hand.forEach((c,j)=>{if(p.hand.some((_,k)=>E.canSwap(game,i,j,k)))targets.push({i,j,label:other.name+' — '+c.race+' '+c.cls+' (+'+other.defense[j]+' defense)'})})});
 return `<section class="deal-turn"><h3>${esc(p.name)}’s steal attempt</h3><p>Round ${Math.floor(game.turn/game.players.length)+1} of ${game.attempts} · ${p.reserve} attack points remaining</p>${targets.length?`<div class="deal-controls"><label>Card to steal<select id="dealTarget">${targets.map(t=>`<option value="${t.i}:${t.j}">${esc(t.label)}</option>`).join('')}</select></label><label>Your card offered in exchange<select id="dealOffer">${offerOptions(targets[0].i,targets[0].j)}</select></label><label>Attack points to spend<input id="dealBid" type="number" min="0" max="${p.reserve}" value="0" step="1"></label></div><p class="deal-muted">Only swaps that keep three different classes in both hands are shown.</p>${action('ROLL THE CONTEST','contest','',true)}`:'<p>No valid unprotected swap is available. Pass to continue.</p>'} ${action('Pass this attempt','pass')}</section>`;
}
function stopSpin(){spinAnimations.forEach(a=>a.cancel());spinAnimations=[];spinning=false}
function reelCard(card){const art=D.HERO_ART[card.faction+'|'+card.race+'|'+card.cls]||D.GREAT_REROLL_CLASS_ICONS[card.cls];return `<div class="deal-reel-slide"><img src="${esc(art)}" alt="" draggable="false"></div>`}
function revealPlayer(player,i){
 const revealed=game.revealed[i],active=i===game.revealIndex;
 return `<div class="deal-reveal-player ${active?'is-active':''}" ${active?'aria-current="step"':''}><div class="deal-reveal-player-head"><b title="${esc(player.name)}">${esc(player.name)}</b><small data-reveal-status="${i}">${revealed?'✓ Spun':active?'Up next':'Waiting'}</small></div><div class="deal-row-slots">${[0,1,2].map(j=>{const card=revealed?player.hand[j]:null;return card?`<div class="deal-row-hero" style="--deal-class:${D.GREAT_REROLL_CLASS_COLORS[card.cls]}" title="${esc(card.race+' '+card.cls)}"><img src="${esc(D.GREAT_REROLL_CLASS_ICONS[card.cls])}" alt=""><span>${esc(card.race)}<b>${esc(card.cls)}</b></span></div>`:'<div class="deal-row-hero is-hidden"><span>?</span></div>'}).join('')}</div></div>`;
}
function revealPool(){
 const counts=new Map();game.players.forEach((p,i)=>{if(game.revealed[i])p.hand.forEach(c=>counts.set(c.key,(counts.get(c.key)||0)+1))});
 return `<section class="deal-board-pool" aria-label="Character pool"><div class="deal-pool-heading"><h3>${esc(game.faction)} character pool</h3><span>Revealed copies · red = dealt · gray = all copies dealt</span></div>${Object.entries(pools[game.faction]).map(([race,classes])=>`<div class="deal-board-race"><b>${esc(race)}</b><div>${classes.map(cls=>{const key=race+'|'+cls,n=counts.get(key)||0,on=enabled[game.faction].has(key);return `<div class="deal-pool-chip ${!on?'is-disabled':n>=game.copies?'is-full':n?'is-dealt':''}" style="--deal-class:${D.GREAT_REROLL_CLASS_COLORS[cls]}" title="${esc(race+' '+cls)}: ${on?n+' of '+game.copies+' copies revealed':'excluded from this game'}"><img src="${esc(D.GREAT_REROLL_CLASS_ICONS[cls])}" alt=""><span>${esc(cls)}</span><small>${on?n+'/'+game.copies:'Off'}</small></div>`}).join('')}</div></div>`).join('')}</section>`;
}
function revealCards(player){return `<div class="deal-reels deal-landed-cards">${player.hand.map(card=>`<article class="deal-reel-shell" style="--deal-class:${D.GREAT_REROLL_CLASS_COLORS[card.cls]}"><div class="deal-reel">${reelCard(card)}</div><div class="deal-reel-caption">${esc(card.race+' '+card.cls)}</div></article>`).join('')}</div>`}
function fitRevealBoard(){
 const width=Math.max(1100,Math.min(1800,window.innerWidth*.98)),height=Math.max(740,window.innerHeight*.96);
 dialog.style.setProperty('--board-width',width+'px');
 dialog.style.setProperty('--board-height',height+'px');
 dialog.style.setProperty('--board-scale',Math.min(1,window.innerWidth*.98/width,window.innerHeight*.96/height));
}
window.addEventListener('resize',()=>{if(game?.phase==='reveal')fitRevealBoard()});
function renderReveal(){
 fitRevealBoard();
 dialog.classList.toggle('deal-board-mode',game.players.length<=14);
 const index=game.revealIndex,p=game.players[index],ready=game.revealed[index];
 content.innerHTML=`<div class="deal-reveal-layout"><aside class="deal-reveal-order" aria-label="Reveal order and results"><h3>The table <small>${game.revealed.filter(Boolean).length} / ${game.players.length} spun</small></h3><div class="deal-reveal-list" style="--players:${game.players.length}" aria-label="Player results">${game.players.map(revealPlayer).join('')}</div></aside><section class="deal-reveal-stage"><div class="deal-kicker">PLAYER ${index+1} OF ${game.players.length}</div><h3>${esc(p.name)} — reveal your heroes</h3>${ready?revealCards(p):`<div class="deal-reels" aria-label="Three unrevealed hero cards">${[0,1,2].map(i=>`<div class="deal-reel-shell"><div class="deal-reel" data-reel="${i}"><div class="deal-card-back"><span>⚔</span><b>THE WAR TABLE</b><small>HERO ${i+1}</small></div></div><div class="deal-reel-caption" data-caption="${i}">Face down</div></div>`).join('')}</div>`}<div class="deal-board-footer"><div id="dealRevealStatus" role="status" class="deal-muted">${ready?'Your hand is revealed.':'Roll when you’re ready.'}</div><div class="deal-actions">${ready?action(index===game.players.length-1?'ENTER SELECTION ROUND →':'NEXT PLAYER →','nextReveal','',true):action('ROLL MY HEROES','spin','',true)}${action('New game','new')}</div></div></section></div>${revealPool()}`;
}
function finishReveal(){
 if(!game||game.phase!=='reveal')return;
 stopSpin();game.revealed[game.revealIndex]=true;renderReveal();
 content.querySelector('[data-action="nextReveal"]').focus({preventScroll:true});
}
function spin(){
 if(spinning||game.phase!=='reveal'||game.revealed[game.revealIndex])return;
 if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){finishReveal();return}
 spinning=true;const activeGame=game,index=game.revealIndex,p=game.players[index];
 content.querySelector(`[data-reveal-status="${index}"]`).textContent='Spinning…';
 const button=content.querySelector('[data-action="spin"]');button.disabled=true;button.textContent='SPINNING…';button.insertAdjacentHTML('afterend',action('Skip animation','skipSpin'));
 content.querySelector('#dealRevealStatus').textContent='The reels are spinning…';
 content.querySelectorAll('[data-caption]').forEach(c=>c.textContent='Spinning…');
 const deck=pool(game.faction);let landed=0;
 for(let j=0;j<3;j++){
  const reel=content.querySelector(`[data-reel="${j}"]`),cards=Array.from({length:16+j*3},()=>deck[Math.floor(Math.random()*deck.length)]);cards.push(p.hand[j]);
  reel.innerHTML=`<div class="deal-reel-track" aria-hidden="true">${cards.map(reelCard).join('')}</div>`;
  const track=reel.firstElementChild,animation=track.animate([{transform:'translateY(0)'},{transform:`translateY(-${(cards.length-1)*100}%)`}],{duration:1900+j*550,easing:'cubic-bezier(.12,.65,.16,1)',fill:'forwards'});
  spinAnimations.push(animation);
  animation.onfinish=()=>{if(!spinning||game!==activeGame||index!==game.revealIndex)return;reel.classList.add('is-landed');reel.parentElement.style.setProperty('--deal-class',D.GREAT_REROLL_CLASS_COLORS[p.hand[j].cls]);reel.parentElement.classList.add('is-landed');content.querySelector(`[data-caption="${j}"]`).textContent=p.hand[j].race+' '+p.hand[j].cls;landed++;if(landed===3)finishReveal()};
 }
}
// Closing mid-spin cancels the presentation, preserving the same assigned hand.
dialog.addEventListener('close',()=>{if(spinning){stopSpin();if(game?.phase==='reveal')renderReveal()}});
function render(){dialog.classList.toggle('deal-board-mode',game?.phase==='reveal'&&game.players.length<=14);if(!game){setup();return}if(game.phase==='reveal'){renderReveal();return}if(game.phase==='selection'){window.GR_SELECTION_UI.render(game,content);return}const labels={defense:'Allocate defense',steal:'Steal round',choose:'Choose your heroes',done:'Your final roster'};const r=pendingResult;content.innerHTML=`<h3>${labels[game.phase]}</h3><p class="deal-muted">${esc(game.faction)} · ${game.players.length} players · ${game.players.length*3} reserved cards · ${game.budget} bonus points each · max ${game.copies} copies per combination</p>${r?`<section class="deal-turn"><h3>${r.won?'STEAL SUCCESSFUL — CARDS SWAPPED':'DEFENDER WINS — HANDS UNCHANGED'}</h3><div class="deal-result">${esc(r.attacker)}: ${r.attackRoll} + ${r.bonus} = <b>${r.attackRoll+r.bonus}</b><br>${esc(r.defender)}: ${r.defenseRoll} + ${r.defense} = <b>${r.defenseRoll+r.defense}</b></div><p>${esc(r.target)}${r.won?' exchanged for '+esc(r.offered):' stays with '+esc(r.defender)}. ${r.bonus} attack points spent.</p>${action('Continue','continue','',true)}</section>`:turn()}${game.phase==='defense'?'<p>Assign points to protect your cards. Keep points unassigned to boost your steal roll. Each player has their own budget; all allocations lock together.</p>':''}${game.phase==='choose'&&!r?'<p>Steals are finished. Everyone may lock in one hero from their own hand, in any order.</p>':''}${ownershipSummary(game.players,game.phase==='done')}${game.phase==='done'?action('Export roster CSV','export'):`<div class="deal-hands">${game.players.map(hand).join('')}</div>`}<div class="deal-actions">${game.phase==='defense'?action('LOCK DEFENSE & BEGIN STEALS','lock','',true):''}${action('New game','new')}</div><details><summary>Game log & turn order</summary><p>Turn order: ${game.order.map(i=>esc(game.players[i].name)).join(' → ')}</p><ol class="deal-log">${game.log.map(l=>`<li>${esc(l)}</li>`).join('')||'<li>No steal attempts yet.</li>'}</ol></details>${rules()}`;}
function open(){document.querySelector('#rerollFlow [data-rr-close]').click();render();dialog.showModal()}
document.getElementById('openDeal').onclick=open;
dialog.addEventListener('input',event=>{const t=event.target;if(t.hasAttribute('data-name'))config.names[+t.dataset.name]=t.value;if(t.hasAttribute('data-defense')){const [i,j]=t.dataset.defense.split(':').map(Number);allocations[i][j]=t.value===''?NaN:Number(t.value);const left=game.budget-allocations[i].reduce((s,n)=>s+n,0);dialog.querySelector(`[data-reserve="${i}"]`).textContent=Number.isFinite(left)?left:'—';}});
dialog.addEventListener('change',event=>fail(()=>{const t=event.target;if(t.hasAttribute('data-reroll')){window.GR_SELECTION_UI.update(game,content);return}if(t.id==='dealCount'){const n=Number(t.value);if(!Number.isInteger(n)||n<1||n>40)throw Error('Choose a whole player count from 1 to 40.');config.names=Array.from({length:n},(_,i)=>config.names[i]??'Player '+(i+1));setup()}else if(t.id==='dealFaction'){config.faction=t.value;setup()}else if(t.id==='dealCopies'){config.copies=Number(t.value);setup()}else if(t.id==='dealBalanced'){config.balanced=t.value==='on'}else if(t.id==='dealTarget'){const [p,j]=t.value.split(':').map(Number);dialog.querySelector('#dealOffer').innerHTML=offerOptions(p,j)}else if(t.id==='dealBudget')config.budget=Number(t.value);else if(t.id==='dealAttempts')config.attempts=Number(t.value);else if(t.hasAttribute('data-pool')){const set=enabled[t.dataset.faction];t.checked?set.add(t.dataset.pool):set.delete(t.dataset.pool);dialog.querySelector('#dealCapacity').textContent=capacity()}}));
dialog.addEventListener('click',event=>{const b=event.target.closest('[data-action]');if(!b)return;fail(()=>{
 const name=b.dataset.action;
 if(selectionBusy&&name!=='close')return;
 if(name.startsWith('sel-')){
  const kind=name.slice(4);window.GR_SELECTION_UI.act(game,kind,b,content);
  if(['order','defend','tiebreak'].includes(kind)&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
   selectionBusy=true;const panel=content.querySelector('.sel-controls');panel.innerHTML='<div class="sel-dice-animation"><span class="sel-die">D100</span><strong>Rolling the dice…</strong></div>';content.querySelectorAll('button').forEach(el=>el.disabled=true);
   const activeGame=game;setTimeout(()=>{selectionBusy=false;if(game===activeGame){render();dialog.scrollTop=0}},1100);
  }else{render();dialog.scrollTop=0}return;
 }

 if(name==='close'){dialog.close();return}
 if(name==='poolFaction'){eligibilityFaction=b.dataset.faction;setup();return}
 if(name==='all'||name==='none'){const f=config.faction==='Either'?eligibilityFaction:config.faction;enabled[f]=new Set(name==='all'?Object.entries(pools[f]).flatMap(([r,cs])=>cs.map(c=>r+'|'+c)):[]);setup();return}
 if(name==='deal'){
  if(!dialog.querySelector('#dealCount').checkValidity()||Number(dialog.querySelector('#dealCount').value)!==config.names.length)throw Error('Enter a valid player count.');
  const budgetField=dialog.querySelector('#dealBudget');
  if(!budgetField.checkValidity()||budgetField.value==='')throw Error('Enter whole bonus points (0–1000).');
  config.budget=Number(budgetField.value);config.attempts=0;
  const fs=config.faction==='Either'?['Horde','Alliance']:[config.faction];for(const f of fs)if(pool(f).length*config.copies<config.names.length*3)throw Error(`${f} needs ${config.names.length*3} dealt cards; only ${pool(f).length*config.copies} cards are available at ${config.copies} copies.`);
  const f=fs[Math.floor(Math.random()*fs.length)];const planned=fs.map(side=>{const g=E.create(config.names,pool(side),config.budget,config.attempts,Math.random,{copies:config.copies,variety:true,balanced:config.balanced});g.faction=side;return g});game=planned.find(g=>g.faction===f);game.faction=f;allocations=game.players.map(()=>[0,0,0]);
  game.afterReveal=game.phase;game.phase='reveal';game.revealIndex=0;game.revealed=game.players.map(()=>false);
 }else if(name==='spin'){spin();return}
 else if(name==='skipSpin'){if(spinning)finishReveal();return}
 else if(name==='nextReveal'){if(game.phase!=='reveal'||spinning||!game.revealed[game.revealIndex])return;if(game.revealIndex<game.players.length-1)game.revealIndex++;else window.GR_SELECTION_ENGINE.start(game,pool(game.faction));}
 else if(name==='lock')E.lockDefense(game,allocations);
 else if(name==='pass')E.pass(game);
 else if(name==='contest'){const [p,j]=dialog.querySelector('#dealTarget').value.split(':').map(Number);const bid=dialog.querySelector('#dealBid');if(bid.value===''||!bid.checkValidity())throw Error('Enter a whole attack bonus within your remaining reserve.');pendingResult=E.contest(game,p,j,Number(dialog.querySelector('#dealOffer').value),Number(bid.value));}
 else if(name==='continue')pendingResult=null;
 else if(name==='choose')E.choose(game,Number(b.dataset.player),Number(b.dataset.slot));
 else if(name==='new'){if(!window.confirm('End this game and return to setup? The current hands and picks will be cleared.'))return;stopSpin();game=null;pendingResult=null}
 else if(name==='export'){const safe=v=>/^[=+@\-\t\r]/.test(v)?"'"+v:v;const rows=[['Player','Faction','Race','Class'],...game.players.map(p=>[p.name,game.faction,p.hand[p.choice].race,p.hand[p.choice].cls])];const csv=rows.map(row=>row.map(v=>'"'+safe(v).replaceAll('"','""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='war-table-deal-roster.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return}
 render();dialog.scrollTop=0;
 });});
})();
