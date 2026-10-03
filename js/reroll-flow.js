(()=>{
const $=id=>document.getElementById(id),flow=$('rerollFlow');if(!flow)return;
const DATA=window.GR_CHARACTER_DATA||{},FACTION_POOLS={Horde:DATA.HORDE||{},Alliance:DATA.ALLIANCE||{}},CLASS_ICONS=DATA.GREAT_REROLL_CLASS_ICONS||{},RACE_ICONS=DATA.GREAT_REROLL_RACE_ICONS||{},CLASS_COLORS=DATA.GREAT_REROLL_CLASS_COLORS||{};
const st={step:1,session:'local',launch:'now',players:['Player 1','Player 2','Player 3','Player 4'],code:'',eligibility:{Horde:null,Alliance:null},eligibilityFaction:'Horde',mode:'new',closeDestination:null};
const copy={
  1:['Create your draft','Choose how your group is playing.'],
  2:['Set the rules','Build the draft your group actually wants.'],
  3:['Gather the group','Add your players or prepare the online lobby.'],
  4:['Refine the pool','Choose which race and class combinations can appear.'],
  5:['Ready the room','Start now or save the draft for later.']
};

function esc(v){return String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function comboKey(r,c){return r+'|'+c}
function factionPool(f){return FACTION_POOLS[f]||{}}
function allFactionKeys(f){return Object.entries(factionPool(f)).flatMap(([r,cs])=>cs.map(c=>comboKey(r,c)))}
function ensureEligibility(f){
  if(st.eligibility[f])return st.eligibility[f];
  const map={};
  allFactionKeys(f).forEach(k=>map[k]=true);

  // Preserve any prior eligibility saved in the legacy settings page when it
  // belongs to the same concrete faction.
  try{
    if(typeof selected!=='undefined' && $('faction') && $('faction').value===f){
      allFactionKeys(f).forEach(k=>{if(k in selected)map[k]=!!selected[k]});
    }
  }catch(e){}
  st.eligibility[f]=map;
  return map;
}
function enabledCount(f){const m=ensureEligibility(f);return allFactionKeys(f).filter(k=>m[k]).length}
function totalCount(f){return allFactionKeys(f).length}
function activeEligibilityFaction(){
  const chosen=$('rrFaction').value;
  if(chosen==='Horde'||chosen==='Alliance'){st.eligibilityFaction=chosen;return chosen}
  return st.eligibilityFaction;
}
function useDefaults(f){const m=ensureEligibility(f);allFactionKeys(f).forEach(k=>m[k]=true)}
function clearEligibility(f){const m=ensureEligibility(f);allFactionKeys(f).forEach(k=>m[k]=false)}

function settings(){return{faction:$('rrFaction').value,detail:$('rrDetail').value,choices:+$('rrChoices').value,duplicates:$('rrDuplicates').value,order:$('rrOrder').value,timer:+$('rrTimer').value}}

function eligibilitySummaryText(){
  const chosen=$('rrFaction').value;
  if(chosen==='Either'){
    return `HORDE ${enabledCount('Horde')}/${totalCount('Horde')} · ALLIANCE ${enabledCount('Alliance')}/${totalCount('Alliance')}`;
  }
  return `${enabledCount(chosen)} / ${totalCount(chosen)} ENABLED`;
}

function summary(){
  let s=settings();
  $('rrSummaryFaction').textContent=s.faction.toUpperCase();
  $('rrSummaryLines').innerHTML=[
    ['Character',s.detail==='spec'?'Race + Class + Spec':'Race + Class'],
    ['Choices',s.choices+' per player'],
    ['Duplicates',s.duplicates==='unique'?'No duplicates':'Allowed'],
    ['Order',s.order==='roll'?'D100 roll':s.order==='random'?'Randomized':'Player order'],
    ['Timer',s.timer?s.timer+' seconds':'Off']
  ].map(x=>`<div><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
  $('rrFinalSession').textContent=st.session==='local'?'LOCAL DRAFT':'ONLINE LOBBY';
  $('rrFinalFaction').textContent=s.faction.toUpperCase();
  $('rrFinalPlayers').textContent=st.session==='local'?st.players.filter(x=>x.trim()).length:($('rrLobbyLimit').value+' MAX');
  $('rrFinalFormat').textContent=s.detail==='spec'?'RACE + CLASS + SPEC':'RACE + CLASS';
  if($('rrFinalEligibility'))$('rrFinalEligibility').textContent=eligibilitySummaryText();
}

function draftSettingsLocked(){
  const live=(typeof draftStarted!=='undefined'&&draftStarted);
  const rolling=(typeof rollState!=='undefined'&&rollState&&rollState.started);
  return !!(live||rolling);
}
function syncDraftSettingsButton(){
  const btn=$('draftSettings'),wrap=$('draftSettingsWrap');
  if(!btn||!wrap)return;
  const locked=draftSettingsLocked();
  btn.disabled=locked;
  wrap.classList.toggle('is-locked',locked);
  btn.setAttribute('aria-disabled',locked?'true':'false');
}
function resetFlowForNewDraft(){
  st.mode='new';st.step=1;st.session='local';st.launch='now';
  st.players=['Player 1','Player 2','Player 3','Player 4'];
  st.code='';st.eligibility={Horde:null,Alliance:null};st.eligibilityFaction='Horde';
  const defaults={rrFaction:'Horde',rrDetail:'class',rrChoices:'3',rrDuplicates:'unique',rrOrder:'roll',rrTimer:'60',rrLobbyLimit:'4'};
  Object.entries(defaults).forEach(([id,v])=>{if($(id)){$(id).value=v;$(id).dispatchEvent(new Event('change',{bubbles:true}))}});
  ensureEligibility('Horde');ensureEligibility('Alliance');
  flow.querySelectorAll('[data-rr-session]').forEach(e=>e.classList.toggle('selected',e.dataset.rrSession==='local'));
  flow.querySelectorAll('[data-rr-launch]').forEach(e=>e.classList.toggle('selected',e.dataset.rrLaunch==='now'));
}
function hydrateSettingsFromDraft(){
  if(typeof draft==='undefined'||!draft)return;
  st.mode='settings';
  st.players=[...(draft.names||st.players)];
  if($('rrFaction')&&draft.faction)$('rrFaction').value=draft.faction;
  if($('rrChoices')&&draft.options!=null)$('rrChoices').value=String(draft.options);
  if($('rrDuplicates')&&draft.duplicates)$('rrDuplicates').value=draft.duplicates;
  if($('rrTimer')&&draft.pickTimer!=null)$('rrTimer').value=String(draft.pickTimer);
  if($('rrDetail')){
    if(draft.format==='spec')$('rrDetail').value='spec';
    else $('rrDetail').value='class';
  }
  try{
    const f=draft.faction;
    if(f==='Horde'||f==='Alliance'){
      const m={};
      allFactionKeys(f).forEach(k=>m[k]=(typeof selected!=='undefined'&&k in selected)?!!selected[k]:true);
      st.eligibility[f]=m;
      st.eligibilityFaction=f;
    }
  }catch(e){}
}
function open(){st.mode='new';st.step=1;flow.classList.remove('rr-settings-mode');flow.classList.remove('hidden');flow.setAttribute('aria-hidden','false');document.body.classList.add('rr-flow-open');render()}
function openSettings(){
  if(draftSettingsLocked())return;
  st.closeDestination=null;
  hydrateSettingsFromDraft();
  st.step=2;
  flow.classList.add('rr-settings-mode');
  flow.classList.remove('hidden');
  flow.setAttribute('aria-hidden','false');
  document.body.classList.add('rr-flow-open');
  render();
}
function close(options={}){
  const destination=st.closeDestination;
  flow.classList.add('hidden');
  flow.classList.remove('rr-settings-mode');
  flow.setAttribute('aria-hidden','true');
  document.body.classList.remove('rr-flow-open');
  st.mode='new';
  st.closeDestination=null;
  syncDraftSettingsButton();

  // If a confirmed NEW DRAFT already cleared the old draft, closing the
  // setup flow should return to the War Table home instead of exposing the
  // retired/empty legacy tool page.
  if(!options.silent && destination==='home'){
    const homeButton=$('grHomeButton');
    if(homeButton){
      homeButton.click();
      return;
    }
    $('setup')?.classList.add('hidden');
    $('draft')?.classList.add('hidden');
    $('grToolNav')?.classList.add('hidden');
    $('grHomeHub')?.classList.remove('hidden');
    document.body.classList.remove('gr-tool-view');
    document.body.classList.add('gr-home-view');
    scrollTo({top:0,behavior:'smooth'});
  }
}

function playersUI(){
  let l=$('rrPlayerList');
  let groups=$('rrSavedGroups');if(!groups){groups=document.createElement('div');groups.id='rrSavedGroups';l.before(groups)}
  window.GR_PLAYER_GROUPS.mount(groups,()=>st.players,names=>{st.players=names;playersUI();summary()});
  l.innerHTML=st.players.map((n,i)=>`<div class="rr-player-row"><span class="rr-player-index">${i+1}</span><input class="rr-field rr-player-name" data-i="${i}" maxlength="32" value="${esc(n)}"><button class="rr-player-remove" type="button" data-remove="${i}" ${st.players.length<=1?'disabled':''}>×</button></div>`).join('');
  l.querySelectorAll('.rr-player-name').forEach(e=>e.oninput=()=>{st.players[+e.dataset.i]=e.value;summary()});
  l.querySelectorAll('[data-remove]').forEach(e=>e.onclick=()=>{if(st.players.length>1){st.players.splice(+e.dataset.remove,1);render()}});
}

function renderEligibility(){
  if(!$('rrEligibilityGrid'))return;
  const chosen=$('rrFaction').value;
  const tabs=$('rrEligibilityFactionTabs');
  tabs.classList.toggle('hidden',chosen!=='Either');

  if(chosen==='Horde'||chosen==='Alliance')st.eligibilityFaction=chosen;
  const f=activeEligibilityFaction();
  const pool=factionPool(f),map=ensureEligibility(f);

  tabs.querySelectorAll('[data-elig-faction]').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.eligFaction===f);
  });

  const count=enabledCount(f),total=totalCount(f);
  $('rrEligibilityCount').textContent=`${count} / ${total} ENABLED`;
  $('rrEligibilityCount').classList.toggle('warn',count===0);

  const notice=$('rrEligibilityNotice');
  if(chosen==='Either'){
    notice.classList.remove('hidden');
    notice.innerHTML=`<b>EITHER FACTION</b><span>Customize both pools with the Horde / Alliance tabs. Whichever faction is rolled at launch will use its saved eligibility.</span>`;
  }else{
    notice.classList.add('hidden');
  }

  $('rrEligibilityGrid').innerHTML=Object.entries(pool).map(([race,classes])=>{
    const raceIcon=RACE_ICONS[f+'|'+race]||'';
    const on=classes.filter(cls=>map[comboKey(race,cls)]).length;
    return `<section class="wt-race-pool" data-race="${esc(race)}">
      <header class="wt-race-pool-head">
        <div class="wt-race-identity">${raceIcon?`<img src="${esc(raceIcon)}" alt="">`:''}<div><strong>${esc(race)}</strong><span>${on} / ${classes.length} enabled</span></div></div>
        <div class="wt-race-actions"><button type="button" data-race-all="${esc(race)}">ALL</button><button type="button" data-race-none="${esc(race)}">NONE</button></div>
      </header>
      <div class="wt-class-pool">${classes.map(cls=>{
        const key=comboKey(race,cls),active=!!map[key],icon=CLASS_ICONS[cls]||'',col=CLASS_COLORS[cls]||'#b9853f';
        return `<button type="button" class="wt-class-toggle ${active?'selected':''}" data-combo="${esc(key)}" style="--wt-class-color:${esc(col)}">${icon?`<img src="${esc(icon)}" alt="">`:''}<span>${esc(cls)}</span><i aria-hidden="true">${active?'✓':''}</i></button>`;
      }).join('')}</div>
    </section>`;
  }).join('');

  $('rrEligibilityGrid').querySelectorAll('[data-combo]').forEach(btn=>btn.onclick=()=>{
    map[btn.dataset.combo]=!map[btn.dataset.combo];
    renderEligibility();summary();
  });
  $('rrEligibilityGrid').querySelectorAll('[data-race-all]').forEach(btn=>btn.onclick=()=>{
    const race=btn.dataset.raceAll;(pool[race]||[]).forEach(cls=>map[comboKey(race,cls)]=true);renderEligibility();summary();
  });
  $('rrEligibilityGrid').querySelectorAll('[data-race-none]').forEach(btn=>btn.onclick=()=>{
    const race=btn.dataset.raceNone;(pool[race]||[]).forEach(cls=>map[comboKey(race,cls)]=false);renderEligibility();summary();
  });
}

function eligibilityValid(){
  const s=settings();
  const factions=s.faction==='Either'?['Horde','Alliance']:[s.faction];
  const people=st.session==='local'?st.players.filter(x=>x.trim()).length:1;
  const required=s.duplicates==='unique'?Math.max(s.choices,people+s.choices-1):s.choices;
  for(const f of factions){
    const count=enabledCount(f);
    if(count===0)return `${f}: enable at least one race/class combination.`;
    if(count<required)return `${f}: enable at least ${required} combinations for these draft settings.`;
  }
  return '';
}

function render(){
  flow.querySelectorAll('[data-rr-step]').forEach(e=>e.classList.toggle('active',+e.dataset.rrStep===st.step));
  flow.querySelectorAll('[data-rr-dot]').forEach(e=>e.classList.toggle('active',+e.dataset.rrDot<=st.step));

  if(st.mode==='settings'){
    $('rrFlowTitle').textContent='Draft settings';
    $('rrFlowSubtitle').textContent='Update the rules or eligibility before the draft begins.';
    $('rrBack').classList.remove('hidden');
    $('rrBack').textContent=st.step===2?'CANCEL':'← BACK';
    $('rrNext').textContent=st.step===2?'CONTINUE →':'SAVE SETTINGS →';
  }else{
    $('rrFlowTitle').textContent=copy[st.step][0];
    $('rrFlowSubtitle').textContent=copy[st.step][1];
    $('rrBack').classList.toggle('hidden',st.step===1);
    $('rrBack').textContent='← BACK';
    $('rrNext').textContent=st.step<5?'CONTINUE →':st.launch==='schedule'?'SAVE DRAFT →':st.session==='online'?'OPEN HOST VIEW →':'START THE REROLL →';
  }

  $('rrLocalPlayers').classList.toggle('hidden',st.session!=='local');
  $('rrOnlineLobby').classList.toggle('hidden',st.session!=='online');
  $('rrStep3Label').textContent=st.session==='local'?'PLAYERS':'LOBBY';
  $('rrOnlineNotice').classList.toggle('hidden',st.session!=='online');
  $('rrScheduleWrap').classList.toggle('hidden',st.launch!=='schedule');
  playersUI();
  if(st.step===4)renderEligibility();
  summary();
  syncDraftSettingsButton();
}

function code(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let o='';for(let i=0;i<5;i++)o+=c[Math.floor(Math.random()*c.length)];return o}
function createLobby(){
  st.code=code();
  let host=($('rrHostName').value||'Host').trim(),url=location.href.split('#')[0].split('?')[0]+'?lobby='+st.code;
  $('rrLobbyCode').textContent=st.code;$('rrInviteLink').textContent=url;$('rrLobbyHostDisplay').textContent=host;$('rrLobbyCreated').classList.remove('hidden');
  try{localStorage.setItem('war-table-online-lobby-preview-v1',JSON.stringify({code:st.code,name:$('rrLobbyName').value,host,limit:+$('rrLobbyLimit').value,settings:settings(),eligibility:st.eligibility,createdAt:new Date().toISOString()}))}catch(e){}
}

function applyEligibilityToLegacy(f){
  const map=ensureEligibility(f);
  try{
    if(typeof selected!=='undefined'){
      allFactionKeys(f).forEach(k=>selected[k]=!!map[k]);
      if(typeof renderCombos==='function')renderCombos();
      if(typeof save==='function')save();
    }
  }catch(e){console.error('Eligibility sync failed',e)}
}

function apply(){
  let s=settings(),f=s.faction==='Either'?(Math.random()<.5?'Horde':'Alliance'):s.faction;
  try{
    if(typeof setDraftMode==='function')setDraftMode('lottery');
    $('lotterySpec').value=s.detail;
    if(typeof setDraftMode==='function')setDraftMode('lottery');

    // Let the legacy engine rebuild the correct faction pool, then apply the
    // eligibility chosen in Step 4 over that pool.
    $('faction').value=f;
    if(typeof $('faction').onchange==='function')$('faction').onchange();
    applyEligibilityToLegacy(f);

    $('options').value=String(s.choices);
    $('duplicates').value=s.duplicates;
    $('draftOrder').value=s.order;
    $('pickTimer').value=String(s.timer);
    $('nameGenerator').value='off';
    players=st.session==='local'?st.players.map(x=>x.trim()).filter(Boolean):[($('rrHostName').value||'Host').trim()];
    if(typeof renderPlayers==='function')renderPlayers();
    if(typeof save==='function')save();
  }catch(e){console.error(e)}
  return f;
}

function chrome(){
  $('grHomeHub')?.classList.add('hidden');$('grToolNav')?.classList.remove('hidden');
  document.body.classList.remove('gr-home-view','name-forge-active');document.body.classList.add('gr-tool-view');
  if($('grToolTitle'))$('grToolTitle').textContent='THE GREAT REROLL';
  if($('grToolSubtitle'))$('grToolSubtitle').textContent='Let fate choose your next character.';
  if($('modeBadge'))$('modeBadge').textContent=st.session==='online'?'ONLINE LOBBY':'LOCAL DRAFT';
}

function saveSettings(){
  const err=eligibilityValid();
  if(err){
    st.step=4;render();
    $('rrEligibilityNotice').classList.remove('hidden');
    $('rrEligibilityNotice').innerHTML=`<b>CHECK THE DRAFT POOL</b><span>${esc(err)}</span>`;
    return;
  }
  apply();
  close({silent:true});
  chrome();
  $('setup')?.classList.add('hidden');
  if(typeof start==='function')start();
  syncDraftSettingsButton();
  scrollTo({top:0,behavior:'smooth'});
}

function launch(){
  apply();close({silent:true});chrome();$('setup')?.classList.add('hidden');
  if(typeof start==='function')start();
  scrollTo({top:0,behavior:'smooth'});
}

function schedule(){
  let when=$('rrScheduleAt').value;if(!when){$('rrScheduleAt').focus();return false}
  let e={
    id:'draft-'+Date.now(),session:st.session,scheduledAt:when,settings:settings(),
    eligibility:JSON.parse(JSON.stringify(st.eligibility)),
    players:st.session==='local'?st.players.map(x=>x.trim()).filter(Boolean):[],
    lobby:st.session==='online'?{code:st.code||null,name:$('rrLobbyName').value,host:$('rrHostName').value,limit:+$('rrLobbyLimit').value}:null,
    savedAt:new Date().toISOString()
  };
  try{let a=JSON.parse(localStorage.getItem('war-table-scheduled-drafts-v1')||'[]');a.push(e);localStorage.setItem('war-table-scheduled-drafts-v1',JSON.stringify(a))}catch(x){}
  $('rrScheduledDone').innerHTML=`<b>DRAFT SAVED</b><br>${new Date(when).toLocaleString()} · ${st.session==='local'?e.players.length+' players':'Online lobby'}<br><span style="opacity:.72">Saved on this device. Calendar/invite delivery can be added with the online layer.</span>`;
  $('rrScheduledDone').classList.remove('hidden');$('rrNext').textContent='DONE';return true;
}

flow.querySelectorAll('[data-rr-close]').forEach(e=>e.onclick=close);
flow.querySelectorAll('[data-rr-session]').forEach(e=>e.onclick=()=>{st.session=e.dataset.rrSession;flow.querySelectorAll('[data-rr-session]').forEach(x=>x.classList.toggle('selected',x===e));render()});
flow.querySelectorAll('[data-rr-launch]').forEach(e=>e.onclick=()=>{st.launch=e.dataset.rrLaunch;flow.querySelectorAll('[data-rr-launch]').forEach(x=>x.classList.toggle('selected',x===e));$('rrScheduledDone').classList.add('hidden');render()});
['rrFaction','rrDetail','rrChoices','rrDuplicates','rrOrder','rrTimer','rrLobbyLimit'].forEach(id=>$(id)?.addEventListener('change',()=>{
  if(id==='rrFaction'){
    const f=$('rrFaction').value;
    if(f==='Horde'||f==='Alliance')st.eligibilityFaction=f;
    if(st.step===4)renderEligibility();
  }
  summary();
}));

$('rrEligibilityFactionTabs')?.querySelectorAll('[data-elig-faction]').forEach(btn=>btn.onclick=()=>{
  st.eligibilityFaction=btn.dataset.eligFaction;renderEligibility();summary();
});
$('rrEligibilityDefaults').onclick=()=>{useDefaults(activeEligibilityFaction());renderEligibility();summary()};
$('rrEligibilityClear').onclick=()=>{clearEligibility(activeEligibilityFaction());renderEligibility();summary()};

$('rrAddPlayer').onclick=()=>{if(st.players.length<40){st.players.push('Player '+(st.players.length+1));render()}};
$('rrCreateLobby').onclick=createLobby;
$('rrCopyInvite').onclick=async()=>{try{await navigator.clipboard.writeText($('rrInviteLink').textContent);$('rrCopyInvite').textContent='COPIED'}catch(e){$('rrCopyInvite').textContent='SELECT LINK'}setTimeout(()=>$('rrCopyInvite').textContent='COPY',1200)};
$('rrBack').onclick=()=>{
  if(st.mode==='settings'){
    if(st.step===2){close();return}
    st.step=2;render();return;
  }
  if(st.step>1){st.step--;render()}
};

$('rrNext').onclick=()=>{
  if(st.mode==='settings'){
    if(st.step===2){st.step=4;render();return}
    if(st.step===4){saveSettings();return}
    return;
  }

  if(st.step<5){
    if(st.step===3&&st.session==='local'&&!st.players.some(x=>x.trim()))return;
    if(st.step===3&&st.session==='online'&&!st.code)createLobby();
    if(st.step===4){
      const err=eligibilityValid();
      if(err){$('rrEligibilityNotice').classList.remove('hidden');$('rrEligibilityNotice').innerHTML=`<b>CHECK THE DRAFT POOL</b><span>${esc(err)}</span>`;return}
    }
    st.step++;render();return;
  }
  if(!$('rrScheduledDone').classList.contains('hidden')){close();return}
  if(st.launch==='schedule'){schedule();return}
  launch();
};

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!flow.classList.contains('hidden'))close()});
if($('grHomeLottery'))$('grHomeLottery').onclick=()=>{st.closeDestination=null;open()};

/* Split live-draft actions:
   NEW DRAFT = destructive reset with the existing confirmation.
   SETTINGS = edit rules/eligibility without creating a new draft. */
if($('backSetup')){
  const legacyBackSetup=$('backSetup').onclick;
  $('backSetup').onclick=function(...args){
    if(typeof legacyBackSetup==='function')legacyBackSetup.apply(this,args);

    // Cancelled confirmation: stay in the current draft.
    if($('draft') && !$('draft').classList.contains('hidden'))return;

    $('setup')?.classList.add('hidden');
    resetFlowForNewDraft();
    st.closeDestination='home';
    open();
    st.closeDestination='home';
  };
}

if($('draftSettings')){
  $('draftSettings').onclick=()=>{
    if(draftSettingsLocked())return;
    openSettings();
  };
}

/* Lock settings as soon as rolling or the live character draft begins. */
['rollStart','unifiedRollStart','launchDraft'].forEach(id=>{
  const btn=$(id);
  if(!btn)return;
  const prior=btn.onclick;
  btn.onclick=function(...args){
    if(typeof prior==='function')prior.apply(this,args);
    syncDraftSettingsButton();
  };
});

ensureEligibility('Horde');ensureEligibility('Alliance');
render();
})();
