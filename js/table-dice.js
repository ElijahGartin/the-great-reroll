/* D100 presentation. Drag gestures never affect the randomly generated result. */
(()=>{'use strict';
const tiers=[{min:100,color:'#e5cc80',name:'Gold'},{min:99,color:'#e268a8',name:'Pink'},{min:95,color:'#ff8000',name:'Orange'},{min:75,color:'#a335ee',name:'Purple'},{min:50,color:'#0070ff',name:'Blue'},{min:25,color:'#1eff00',name:'Green'},{min:1,color:'#9d9d9d',name:'Gray'}];
const tier=n=>tiers.find(t=>n>=t.min)||tiers.at(-1);
function score(n,extra=''){const t=tier(n);return `<span class="wt-roll-score ${extra}" style="--roll-color:${t.color}" aria-label="Roll ${n}, ${t.name}">${n}</span>`}
function legend(){return `<details class="wt-roll-legend"><summary>Roll colors · raw D100 only</summary><div>${[...tiers].reverse().map((t,i,a)=>`<span style="--roll-color:${t.color}"><b>${t.name}</b> ${t.min}${i<4?'–'+(a[i+1].min-1):i===4?'–98':''}</span>`).join('')}</div><p>Color shows the raw roll, not the total after bonuses. A higher total wins.</p></details>`}
function shape(){return `<svg viewBox="0 0 160 160" aria-hidden="true"><path d="M80 5 147 43 147 117 80 155 13 117 13 43Z" fill="#282b34"/><path d="M80 5 45 56 13 43M80 5l35 51 32-13M13 117l32-61 70 0 32 61M13 117l67 38 67-38M45 56l35 64 35-64M13 117l67 3 67-3M80 120v35" fill="none" stroke="currentColor" stroke-width="2"/></svg>`}
function die(action,player){return `<div class="wt-dice-tray"><div class="wt-dice-target">THE WAR TABLE</div><button type="button" class="wt-hand-die" data-throw-action="${action}" data-player="${player}" aria-label="Grab and throw the D100, or press Enter to roll">${shape()}<span>D100</span></button><p>Grab → drag → release to roll</p></div><div class="wt-dice-actions"><button type="button" class="deal-primary" data-action="sel-${action}" data-player="${player}">Roll D100</button><span>Click, touch, or press Enter also works.</span></div>`}
let drag=null,suppressClick=null;
function reset(){if(drag){drag.el.style.transform='';drag.el.classList.remove('is-grabbed');drag=null}}
function fire(el){if(el.disabled)return;const b=document.createElement('button');b.dataset.action='sel-'+el.dataset.throwAction;b.dataset.player=el.dataset.player;b.hidden=true;el.parentElement.appendChild(b);b.click();b.remove()}
document.addEventListener('pointerdown',e=>{const el=e.target.closest('.wt-hand-die');if(!el||el.disabled||!e.isPrimary||e.button!==0)return;drag={el,id:e.pointerId,x:e.clientX,y:e.clientY,distance:0};el.setPointerCapture(e.pointerId);el.classList.add('is-grabbed')});
document.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const dx=Math.max(-100,Math.min(100,e.clientX-drag.x)),dy=Math.max(-65,Math.min(65,e.clientY-drag.y));drag.distance=Math.hypot(e.clientX-drag.x,e.clientY-drag.y);drag.el.style.transform=`translate(${dx}px,${dy}px) rotate(${dx*.3}deg) scale(1.08)`});
document.addEventListener('pointerup',e=>{if(!drag||e.pointerId!==drag.id)return;const {el,distance}=drag;reset();if(distance>=15){suppressClick=el;setTimeout(()=>{if(suppressClick===el)suppressClick=null},400);fire(el)}});
document.addEventListener('pointercancel',reset);document.addEventListener('lostpointercapture',reset);window.addEventListener('blur',reset);
document.addEventListener('click',e=>{const el=e.target.closest('.wt-hand-die');if(!el)return;if(suppressClick===el){suppressClick=null;return}fire(el)});
window.GR_TABLE_DICE={tier,score,legend,die,shape};
})();
