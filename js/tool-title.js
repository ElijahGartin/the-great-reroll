/* Retitles the shared tool header when a homepage tool is opened. */
(function(){
  const title=document.getElementById('grToolTitle');
  const subtitle=document.getElementById('grToolSubtitle');
  function renameTool(kind){
    if(!title||!subtitle)return;
    if(kind==='lottery'){title.textContent='THE GREAT REROLL';subtitle.textContent='Let fate choose your next character.';}
    if(kind==='forge'){title.textContent='NAME FORGE';subtitle.textContent='Forge your character identity.';}
    if(kind==='roster'){title.textContent='GUILD HALL';subtitle.textContent='Build your roster and shape your composition.';}
  }
  document.getElementById('grHomeLottery')?.addEventListener('click',()=>setTimeout(()=>renameTool('lottery'),0));
  document.getElementById('grHomeForge')?.addEventListener('click',()=>setTimeout(()=>renameTool('forge'),0));
  document.getElementById('grHomeRoster')?.addEventListener('click',()=>setTimeout(()=>renameTool('roster'),0));
})();
