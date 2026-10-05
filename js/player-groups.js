/* Shared browser-local player lists. Import/export never changes a saved list silently. */
(()=>{
 const KEY='war-table-player-groups-v1',esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function validate(groups){if(!Array.isArray(groups)||groups.length>100)throw Error('Import up to 100 groups.');const ids=new Set();return groups.map(g=>{if(!g||typeof g.id!=='string'||ids.has(g.id)||typeof g.name!=='string'||!g.name.trim()||g.name.length>60||!Array.isArray(g.players)||!g.players.length||g.players.length>40||g.players.some(n=>typeof n!=='string'||!n.trim()||n.length>32)||new Set(g.players.map(n=>n.trim().toLowerCase())).size!==g.players.length)throw Error('Each group needs a name and 1–40 different player names (up to 32 characters each).');ids.add(g.id);return{id:g.id,name:g.name.trim(),players:g.players.map(n=>n.trim())}})}
 function read(){return validate(JSON.parse(localStorage.getItem(KEY)||'[]'))}
 function write(groups){localStorage.setItem(KEY,JSON.stringify(validate(groups)))}
 function mount(root,getNames,setNames){
  const chosen=root.dataset.groupId||'';let groups=[];
  root.classList.add('wt-player-groups');
  root.innerHTML='<strong>Saved player groups</strong><div class="wt-group-controls"><label>Load group<select class="wt-group-select"><option value="">Choose a saved group…</option></select></label><button type="button" data-group-action="load">Load</button><button type="button" data-group-action="save">Save as new</button><button type="button" data-group-action="update">Update group</button><button type="button" data-group-action="rename">Rename</button><button type="button" data-group-action="delete">Delete</button><button type="button" data-group-action="export">Export groups</button><button type="button" data-group-action="import">Import groups</button><input class="wt-group-file" type="file" accept="application/json,.json" hidden></div><p class="wt-group-message" role="status">Saved on this browser/device. Export a backup before clearing site data.</p>';
  const select=root.querySelector('select'),message=root.querySelector('.wt-group-message');
  const report=fn=>{try{fn()}catch(e){message.textContent=e.message||'Browser storage is unavailable. Try another browser or enable site storage.'}};
  function refresh(){groups=read();select.innerHTML='<option value="">Choose a saved group…</option>'+groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)} (${g.players.length})</option>`).join('');select.value=root.dataset.groupId||'';root.querySelectorAll('[data-group-action]').forEach(b=>{if(['load','update','rename','delete'].includes(b.dataset.groupAction))b.disabled=!select.value})}
  select.onchange=()=>{root.dataset.groupId=select.value;refresh()};root.dataset.groupId=chosen;report(refresh);
  root.onclick=e=>{const button=e.target.closest('[data-group-action]');if(!button)return;report(()=>{
   groups=read();const g=groups.find(g=>g.id===select.value),act=button.dataset.groupAction;
   if(act==='load'){if(!g)return;setNames([...g.players]);message.textContent='Loaded '+g.name+'. Edits only affect this draft until you update the group.';return}
   if(act==='save'){const name=prompt('Name this player group:');if(name===null)return;if(groups.some(g=>g.name.toLowerCase()===name.trim().toLowerCase()))throw Error('That group name already exists. Choose it and use Update group.');const item={id:crypto.randomUUID(),name,players:[...getNames()]};write([...groups,item]);root.dataset.groupId=item.id}
   if(act==='update'){if(!g)return;if(!confirm('Replace the saved players in '+g.name+' with the current list?'))return;g.players=[...getNames()];write(groups)}
   if(act==='rename'){if(!g)return;const name=prompt('New group name:',g.name);if(name===null)return;if(groups.some(other=>other.id!==g.id&&other.name.toLowerCase()===name.trim().toLowerCase()))throw Error('That group name already exists.');g.name=name;write(groups)}
   if(act==='delete'){if(!g||!confirm('Delete saved group '+g.name+'?'))return;write(groups.filter(x=>x.id!==g.id));root.dataset.groupId=''}
   if(act==='export'){const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,groups},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='war-table-player-groups.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return}
   if(act==='import'){root.querySelector('input[type=file]').click();return}
   refresh();message.textContent='Saved player groups updated.';
  })};
  root.querySelector('input[type=file]').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(file.size>250000){message.textContent='Choose a group file smaller than 250 KB.';return}try{const parsed=JSON.parse(await file.text());if(parsed.version!==1)throw Error('Unsupported group file version.');const imported=validate(parsed.groups),existing=read();const merged=[...existing];for(const item of imported){let name=item.name,count=2;while(merged.some(g=>g.name.toLowerCase()===name.toLowerCase()))name=item.name.slice(0,50)+' (import '+count+++')';merged.push({...item,id:crypto.randomUUID(),name})}write(merged);refresh();message.textContent=`Imported ${imported.length} groups. Existing groups were kept.`}catch(err){message.textContent=err.message}e.target.value=''};
 }
 window.GR_PLAYER_GROUPS={mount};
})();
