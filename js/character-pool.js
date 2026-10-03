/* Compact pool: presentation only; eligibility and draft rules stay in app.js. */
(()=>{
  const panel=$('characterPoolPanel'), grid=$('liveDraftContent').querySelector('.cols');
  const center=grid.children[1];
  center.id='draftCenter';
  grid.appendChild(panel);
  panel.innerHTML='<button type="button" id="poolToggle" aria-expanded="false" aria-controls="poolBody">Character pool <span>View pool ▾</span></button><div id="poolSummary" aria-live="polite"></div><div id="poolBody"><div id="fullPool"></div><p id="poolDetail" aria-live="polite">Hover or tap a race for details.</p><p id="poolLegend"></p></div>';
  const toggle=$('poolToggle');
  toggle.onclick=()=>{const expanded=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(expanded));panel.classList.toggle('pool-open',expanded);toggle.querySelector('span').textContent=expanded?'Hide pool ▴':'View pool ▾';};
  const short={Orc:'ORC',Troll:'TRL',Tauren:'TAU',Undead:'UD',Skyborne:'SKY',Human:'HUM',Dwarf:'DWF',Gnome:'GNM','Night Elf':'NE','Night elf':'NE'};
  renderFullPool=function(){
    if(!draft)return;
    const first=twoStageMode()&&stagePhase===1;
    const picks=twoStageMode()?(first?stageOnePicks:stageTwoPicks):draft.picks;
    const entries=first?stageOneVariants():combinations();
    const groups=new Map();let unavailable=0,drafted=0;
    for(const v of entries){
      const owners=picks.filter(p=>p&&p.key===v.key).map(p=>p.player);
      // Stage-one race/role choices are repeatable in the existing engine.
      const taken=!first&&draft.duplicates==='unique'&&owners.length>0;
      if(taken)unavailable++;if(owners.length)drafted++;
      const label=first?v.role:v.cls;
      if(!groups.has(label))groups.set(label,[]);
      const detail=v.race+' '+label+' — '+(taken?'Taken by '+owners.join(', '):owners.length?'Available again; picked by '+owners.join(', '):'Available');
      groups.get(label).push(`<button type="button" class="pool-race${taken?' is-taken':''}" data-detail="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}" title="${escapeHtml(detail)}">${escapeHtml(short[v.race]||v.race)}${owners.length&&!taken?'<sup>↻</sup>':''}</button>`);
    }
    $('poolSummary').textContent=`${entries.length-unavailable} available · ${unavailable} taken`;
    $('fullPool').innerHTML=[...groups].map(([label,races])=>`<div class="pool-class-row"><span class="pool-class" style="color:${grClassColor(label)}">${first?'':`<img src="${escapeHtml(grClassIcon(label))}" alt="" width="16" height="16">`}${escapeHtml(label)}</span><div class="pool-races">${races.join('')}</div></div>`).join('')||'<p>No enabled combinations.</p>';
    $('poolLegend').textContent=first?'Race + role · repeatable choices':draft.duplicates==='repeat'?`Duplicates allowed · ${drafted} combinations picked · ↻ picked before`:'Crossed out = taken';
    $('poolDetail').textContent='Hover or tap a race for details.';
    $('fullPool').querySelectorAll('.pool-race').forEach(button=>{const show=()=>{$('poolDetail').textContent=button.dataset.detail;};button.onmouseenter=show;button.onfocus=show;button.onclick=show;});
  };
  if(draft)renderFullPool();
})();
