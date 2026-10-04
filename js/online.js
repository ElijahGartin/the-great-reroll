/* Private multiplayer client. Seat credentials live in HttpOnly cookies or memory only. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.GR_CHARACTER_DATA;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label = card => [card.race, card.cls, card.spec, card.role].filter(Boolean).join(' · ');
  const state = {room:null, participantId:null, token:null, code:null, pending:null, busy:false, polling:false};
  let pollTimer;
  const connection = message => { $('connection').textContent = message; };
  const error = message => { $('error').textContent = message; $('error').hidden = !message; };
  const button = (text, action, payload = {}, disabled = false) => `<button type="button" data-action="${esc(action)}" data-payload="${esc(JSON.stringify(payload))}"${disabled ? ' disabled' : ''}>${esc(text)}</button>`;
  const isHost = () => state.room.hostId === state.participantId;
  const canPlay = () => !!state.code && state.room.status === 'playing' && !state.busy && !state.pending;
  function cardHTML(card, body = '') {
    const source = data.HERO_ART[[card.faction || state.room.game?.faction, card.race, card.cls].join('|')];
    return `<article class="card">${source ? `<img src="${esc(source)}" alt="" loading="lazy">` : ''}<h3>${esc(label(card))}</h3>${card.protected ? '<p class="pill">Protected from swaps</p>' : ''}${body}</article>`;
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, {method:body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store', signal:controller.signal, headers:body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const failure = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Request failed (${response.status}).`);
        failure.status = response.status;
        throw failure;
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  function remember(code) {
    try {
      const previous = JSON.parse(localStorage.getItem('reroll-recent-rooms') || '[]');
      localStorage.setItem('reroll-recent-rooms', JSON.stringify([code, ...(Array.isArray(previous) ? previous : []).filter(c => c !== code)].slice(0, 8)));
    } catch (_) { /* Storage is optional; never store credentials. */ }
  }
  function accept(result, force = false) {
    const room = result.room;
    if (!room) throw new Error('The server returned an incomplete room. Please refresh.');
    if (state.room?.code === room.code && room.version < state.room.version) { if (force) render(); return; }
    const changed = force || !state.room || room.version !== state.room.version;
    state.room = room;
    state.code = room.code;
    if (result.participantId) state.participantId = result.participantId;
    if (result.token) {
      state.token = result.token;
      $('recovery-token').value = result.token;
      $('recovery').hidden = false;
      $('recovery').open = true;
    }
    remember(room.code);
    $('entry').hidden = true;
    $('session').hidden = false;
    const invite = new URL('online.html', location.href);
    invite.searchParams.set('room', room.code);
    $('invite').value = invite.href;
    history.replaceState(null, '', invite.pathname + invite.search);
    if (changed) render();
    connection(`Saved · ${new Date(room.updatedAt).toLocaleString()} · Retained until ${new Date(room.expiresAt).toLocaleString()}`);
    if (!pollTimer) schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, document.hidden ? 15000 : 1500);
  }
  async function poll() {
    pollTimer = null;
    if (!state.code || state.polling) return;
    state.polling = true;
    try {
      const code = state.code;
      const result = await api(`/api/rooms/${encodeURIComponent(code)}`);
      if (code === state.code) accept(result);
    } catch (failure) {
      if ([401,403,404,410].includes(failure.status)) {
        connection(failure.status === 410 || failure.status === 404 ? 'Room expired or unavailable. Reopen a room or create a new one.' : 'Seat access expired. Reopen this room with your private recovery code.');
        error(failure.message);
        $('entry').hidden = false;
        $('session').hidden = true;
        state.pending = null; $('retry').hidden = true;
        $('recover').elements.code.value = state.code;
        state.code = null;
      } else connection('Reconnecting… Your last confirmed progress is saved.');
    } finally {
      state.polling = false;
      if (state.code) schedulePoll();
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.code) { clearTimeout(pollTimer); poll(); } });
  function setBusy(value) {
    state.busy = value;
    $('room-content').querySelectorAll('button,input,select').forEach(node => {
      if (value) { node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else if ('wasDisabled' in node.dataset) { node.disabled = node.dataset.wasDisabled === 'true'; delete node.dataset.wasDisabled; }
    });
  }
  async function perform(type, payload = {}) {
    if (state.busy || state.pending) return;
    state.pending = {id:crypto.randomUUID(), version:state.room.version, type, payload};
    await sendPending();
  }
  async function sendPending() {
    if (state.busy || !state.pending) return;
    setBusy(true);
    error('');
    $('retry').hidden = true;
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(state.code)}/actions`, state.pending);
      state.pending = null;
      setBusy(false);
      accept(result, true);
    } catch (failure) {
      setBusy(false);
      if (failure.status) {
        state.pending = null;
        if (failure.status === 409) {
          await poll();
          error('The room changed before your action arrived. Review the current turn, then choose again.');
        } else error(failure.message);
        render();
      } else {
        error('Connection interrupted. Your action may have been saved. Retry this exact action to safely check its result.');
        $('retry').hidden = false;
      }
    }
  }
  $('retry').onclick = sendPending;
  async function enter(form, kind) {
    const submit = form.querySelector('button');
    submit.disabled = true;
    error('');
    try {
      const fields = form.elements;
      let result;
      if (kind === 'create') {
        const config = {faction:fields.faction.value, format:fields.format.value, options:+fields.options.value, stageTwoOptions:+fields.stageTwoOptions.value, duplicates:fields.duplicates.value, order:fields.order.value, pickTimer:+fields.pickTimer.value, enforce:fields.enforce.value, budget:+fields.budget.value, attempts:+fields.attempts.value, eligibility:{}, requirements:{}};
        for (const faction of ['Horde','Alliance']) config.eligibility[faction] = Array.from(form.querySelectorAll(`[data-faction="${faction}"]:checked`), input => input.value);
        for (const role of data.ROLES) {
          const min = form.querySelector(`[data-role-min="${role}"]`).value;
          const max = form.querySelector(`[data-role-max="${role}"]`).value;
          if (min !== '' || max !== '') config.requirements[`role:${role}`] = {...(min === '' ? {} : {min:+min}), ...(max === '' ? {} : {max:+max})};
        }
        result = await api('/api/rooms', {name:fields.name.value.trim(), mode:fields.mode.value, config});
      } else {
        const code = fields.code.value.trim().toUpperCase();
        result = kind === 'join' ? await api(`/api/rooms/${encodeURIComponent(code)}/join`, {name:fields.name.value.trim()}) : fields.token.value.trim() ? await api(`/api/rooms/${encodeURIComponent(code)}/resume`, {token:fields.token.value.trim()}) : await api(`/api/rooms/${encodeURIComponent(code)}`);
      }
      clearTimeout(pollTimer); pollTimer = null;
      state.room = null; state.participantId = null; state.token = null; state.pending = null;
      $('retry').hidden = true; $('recovery').hidden = true; $('recovery-token').value = '';
      if (kind === 'recover' && fields.token.value.trim()) result.token = fields.token.value.trim();
      accept(result, true);
      if (fields.token) fields.token.value = '';
    } catch (failure) { error(failure.message); }
    finally { submit.disabled = false; }
  }
  for (const id of ['create','join','recover']) $(id).onsubmit = event => { event.preventDefault(); enter($(id), id); };
  $('create').elements.mode.onchange = () => {
    const deal = $('create').elements.mode.value === 'deal';
    $('draft-settings').hidden = deal; $('deal-settings').hidden = !deal;
  };
  $('create').elements.format.onchange = () => {
    const roster = $('create').elements.format.value === 'twostage';
    $('stage-two-options').hidden = !roster; $('role-requirements').hidden = !roster;
  };
  $('requirements').innerHTML = data.ROLES.map(role => `<fieldset><legend>${esc(role)}</legend><div class="requirement"><label>Minimum<input type="number" min="0" max="40" data-role-min="${esc(role)}" placeholder="0"></label><label>Maximum<input type="number" min="0" max="40" data-role-max="${esc(role)}" placeholder="No limit"></label></div></fieldset>`).join('');
  $('eligibility').innerHTML = ['Horde','Alliance'].map(faction => `<details><summary>${faction}</summary><div class="pool">${Object.entries(data[faction.toUpperCase()]).flatMap(([race, classes]) => classes.map(cls => `<label class="check"><input type="checkbox" data-faction="${faction}" value="${esc(race+'|'+cls)}" checked>${esc(race+' · '+cls)}</label>`)).join('')}</div></details>`).join('');
  function render() {
    const room = state.room;
    $('room-title').textContent = `Room ${room.code} · ${room.status}`;
    $('room-description').textContent = `${room.mode === 'deal' ? 'Deal Everyone' : room.config.format === 'twostage' ? 'Guild Roster' : 'Character Lottery'} · ${room.game?.faction || room.config.faction} · ${room.participants.length} players · You: ${room.participants.find(p => p.id === state.participantId)?.name || 'Guest'}`;
    let html = '';
    if (room.status === 'lobby') html = lobby();
    else {
      html = `<div class="panel toolbar"><span>${room.status === 'paused' ? 'Paused and saved. Resume whenever the party is ready.' : room.status === 'done' ? 'The reroll is complete. Export your results above.' : 'Progress is saved automatically after every action.'}</span>${isHost() && ['playing','paused'].includes(room.status) ? button(room.status === 'paused' ? 'Resume game' : 'Pause & save', room.status === 'paused' ? 'resume' : 'pause') : ''}</div>`;
      if (isHost() && room.status !== 'done' && room.participants.length > 1) html += `<details class="panel"><summary>Host controls</summary><p>Pass hosting to another guest before leaving.</p>${room.participants.filter(p => p.id !== room.hostId).map(p => button('Make '+p.name+' host','transfer-host',{participantId:p.id})).join(' ')}</details>`;
      html += room.mode === 'deal' ? dealView() : draftView();
    }
    const container = $('room-content');
    // Keep editable values across unrelated player updates; discard them on a phase/turn change.
    const context = [room.status,room.game?.phase,room.game?.stage,room.game?.turn].join(':');
    const inputs = container.dataset.context === context ? Array.from(container.querySelectorAll('input[id],select[id]'), input => [input.id,input.value]) : [];
    const focus = container.contains(document.activeElement) ? document.activeElement.id : '';
    container.innerHTML = html;
    container.dataset.context = context;
    for (const [id,value] of inputs) if ($(id)) $(id).value = value;
    if (focus && $(focus)) $(focus).focus({preventScroll:true});
    bindRoomControls();
    updateDeadline();
  }
  function lobby() {
    const room = state.room, self = room.participants.find(p => p.id === state.participantId);
    return `<div class="panel"><h2>Ready the room</h2><p>Share the invite and wait for your group. All guests must mark themselves ready. The host can start when everyone is here.</p><ul>${room.participants.map(p => `<li><strong>${esc(p.name)}</strong> · ${p.id === room.hostId ? 'Host · ' : ''}${p.ready ? 'Ready' : 'Not ready'} ${isHost() && p.id !== room.hostId ? button('Make host','transfer-host',{participantId:p.id})+' '+button('Remove from lobby','remove-player',{participantId:p.id}) : ''}</li>`).join('')}</ul><div class="toolbar">${button(self?.ready ? 'Not ready yet' : "I'm ready",'ready',{ready:!self?.ready})}${isHost() ? button('Start game','start',{},!room.participants.every(p => p.ready)) : ''}</div><details><summary>Room rules</summary><p>${esc(room.config.faction)} · ${esc(room.config.format || room.mode)} · ${room.config.pickTimer ? esc(room.config.pickTimer)+' second picks' : 'No pick timer'} · ${esc(room.config.duplicates || 'unique')} characters · ${esc(room.config.enforce || 'none')} role enforcement</p>${room.mode === 'deal' ? `<p>${esc(room.config.budget)} defense points · ${esc(room.config.attempts)} steal attempts</p>` : ''}</details></div>`;
  }
  function draftView() {
    const game = state.room.game;
    const actor = game.players[game.order[game.turn]];
    const mine = actor?.id === state.participantId && canPlay();
    let html = `<div class="panel"><h2>${game.phase === 'done' ? 'Your final roster' : game.phase === 'stage-break' ? 'Race and role assignments locked' : `Stage ${game.stage || 1} · ${esc(actor?.name || '')}'s turn`}</h2><p id="deadline" role="timer"></p>`;
    if (game.phase === 'draft') {
      html += `<p>${mine ? 'Choose a character and lock your selection.' : `Waiting for ${esc(actor?.name || 'the next player')}.`} ${game.config?.enforce === 'soft' ? 'Role requirements are advisory.' : ''}</p>${state.room.config.format === 'twostage' && game.stage === 1 ? '' : `<label>Character name (optional)<input id="character-name" maxlength="36"${mine ? '' : ' disabled'}></label>`}<div class="cards">${game.offers.map((card,index) => cardHTML(card,button('Lock this selection','pick',{index},!mine))).join('')}</div><div class="toolbar">${button('Second-chance spin','spin',{},!mine || game.spent?.includes(state.participantId))}<small>One second-chance spin per player across both stages.</small></div>`;
      if (game.pending) html += `<p>Pending selection: ${esc(label(game.offers[game.pending.index] || {}))}</p>${button('Confirm pending selection','confirm',{},!mine)}`;
    }
    if (game.phase === 'stage-break') html += `<p>Each player's race and role carry into the class and specialization draft.</p>${isHost() ? button('Begin class & spec draft','begin-stage2',{},!canPlay()) : '<p>Waiting for the host to start stage two.</p>'}`;
    if (state.room.config.format === 'twostage') {
      html += '<h3>Guild composition</h3><ul>' + data.ROLES.map(role => {
        const count = game.assignments.filter(pick => pick.role === role).length;
        const target = state.room.config.requirements?.['role:'+role] || {};
        return `<li>${esc(role)}: ${count} · target ${target.min || 0}–${target.max || 'any'}${target.min > count ? ' · minimum not yet met' : target.max && count > target.max ? ' · above maximum' : ''}</li>`;
      }).join('') + '</ul>';
    }
    html += '</div><div class="columns"><div class="panel"><h2>Draft board</h2><ol>';
    html += game.order.map(index => `<li>${esc(game.players[index].name)}${game.players[index].id === actor?.id && game.phase === 'draft' ? ' · Current turn' : ''}</li>`).join('');
    html += `</ol>${game.rolls?.length ? `<details><summary>Initiative rolls</summary><ul>${game.rolls.map(roll => `<li>${esc(roll.name)}: ${esc(roll.history.join(' → '))}</li>`).join('')}</ul></details>` : ''}</div><div class="panel"><h2>Locked selections</h2>${(game.picks || []).filter(Boolean).map(pick => `<p><strong>${esc(pick.player || game.players.find(p => p.id === pick.playerId)?.name)}</strong>: ${esc(label(pick))}${pick.name ? ` · ${esc(pick.name)}` : ''}</p>`).join('') || '<p>No characters locked yet.</p>'}${(game.assignments || []).filter(Boolean).map(pick => `<p>${esc(pick.player)} · ${esc(pick.race)} · ${esc(pick.role)}</p>`).join('')}</div></div>`;
    return html;
  }
  function dealView() {
    const game = state.room.game;
    const ownIndex = game.players.findIndex(p => p.id === state.participantId), own = game.players[ownIndex];
    const actorIndex = game.order[game.turn % game.order.length], actor = game.players[actorIndex];
    const mine = actorIndex === ownIndex && canPlay();
    const submitted = !!game.submissions?.[state.participantId];
    let html = `<div class="panel"><h2>${esc(({defense:'Allocate your defense',steal:`Steal round · ${actor.name}'s turn`,choose:'Choose your final character',done:'The final lineup'})[game.phase])}</h2><p>${({defense:`Spend up to ${game.budget} points across your three cards. Unspent points become your attack reserve. Allocations lock when submitted.`,steal:'Target an unprotected card. Your D100 + attack bonus must beat their D100 + defense. Ties defend. Spent attack points are gone even if you lose. A winning target becomes protected.',choose:'Everyone can now lock one card from their own hand.',done:'Your final characters are saved and ready to export.'})[game.phase]}</p>`;
    if (game.phase === 'defense') html += `<p>${Object.keys(game.submissions || {}).length} / ${game.players.length} players locked defense.</p>${submitted ? '<p>Your defense is locked. Waiting for the other players.</p>' : ''}`;
    if (game.phase === 'steal' && mine) {
      const targets = game.players.flatMap((player,index) => index === ownIndex ? [] : player.hand.flatMap((card,slot) => card.protected ? [] : [`<option value="${index}:${slot}">${esc(player.name)} · ${esc(label(card))} · defense ${player.defense[slot]}</option>`]));
      const offers = own.hand.flatMap((card,slot) => card.protected ? [] : [`<option value="${slot}">${esc(label(card))}</option>`]);
      html += `<form id="contest"><label>Target card<select id="target-card" required>${targets.join('')}</select></label><label>Your offered card<select id="offered-card" required>${offers.join('')}</select></label><label>Attack bonus · ${own.reserve} reserve remaining<input id="attack-bonus" type="number" value="0" min="0" max="${own.reserve}" required></label><div class="toolbar"><button${targets.length && offers.length ? '' : ' disabled'}>Roll for the steal</button>${button('Pass this attempt','pass')}</div></form>`;
    }
    if (game.lastResult) html += `<p class="pill">Last roll: ${esc(game.lastResult.attacker)} ${game.lastResult.attackRoll} + ${game.lastResult.bonus} vs ${esc(game.lastResult.defender)} ${game.lastResult.defenseRoll} + ${game.lastResult.defense} · ${game.lastResult.won ? 'Cards swapped' : 'Defender keeps their card'}</p>`;
    html += '</div>';
    for (const [index, player] of game.players.entries()) {
      html += `<div class="panel"><h2>${esc(player.name)}${index === ownIndex ? ' · You' : ''}</h2><p>Attack reserve: ${player.reserve}${game.submissions?.[player.id] ? ' · Defense locked' : ''}</p><div class="cards">`;
      html += player.hand.map((card,slot) => {
        let body = `<p>Defense: ${game.submissions?.[player.id]?.[slot] ?? player.defense[slot]}</p>`;
        if (index === ownIndex && game.phase === 'defense' && !submitted) body += `<label>Defense points<input id="defense-${slot}" type="number" value="0" min="0" max="${game.budget}"${canPlay() ? '' : ' disabled'}></label>`;
        if (game.phase === 'choose' && index === ownIndex && player.choice === null) body += button('Keep this character','choose',{slot},!canPlay());
        if (player.choice === slot) body += '<p class="pill">Final selection</p>';
        return cardHTML(card,body);
      }).join('');
      html += `</div>${index === ownIndex && game.phase === 'defense' && !submitted ? button('Lock my defense','defense',{},!canPlay()) : ''}</div>`;
    }
    if (game.log?.length) html += `<details class="panel"><summary>Round history</summary><ol>${game.log.map(line => `<li>${esc(line)}</li>`).join('')}</ol></details>`;
    return html;
  }
  function bindRoomControls() {
    $('room-content').querySelectorAll('[data-action]').forEach(node => node.onclick = () => {
      const type = node.dataset.action, payload = JSON.parse(node.dataset.payload);
      if (type === 'pick' || type === 'confirm') payload.name = $('character-name')?.value.trim() || '';
      if (type === 'defense') {
        const inputs = [0,1,2].map(index => $(`defense-${index}`));
        if (!inputs.every(input => input.reportValidity())) return;
        payload.allocations = inputs.map(input => +input.value);
        if (payload.allocations.reduce((a,b) => a+b,0) > state.room.game.budget) { error('Defense allocations exceed your budget. Reduce the points and try again.'); return; }
      }
      perform(type,payload);
    });
    if ($('contest')) $('contest').onsubmit = event => {
      event.preventDefault();
      const [target,slot] = $('target-card').value.split(':').map(Number);
      perform('contest',{target,slot,offered:+$('offered-card').value,bonus:+$('attack-bonus').value});
    };
  }
  function updateDeadline() {
    if (!$('deadline')) return;
    const deadline = state.room?.game?.deadline;
    $('deadline').textContent = deadline && state.room.status === 'playing' ? `Pick clock: ${Math.max(0,Math.ceil((deadline - Date.now())/1000))} seconds · the server locks a selection when time runs out.` : '';
  }
  setInterval(updateDeadline,1000);
  async function copy(value, description) {
    try { await navigator.clipboard.writeText(value); connection(`${description} copied.`); }
    catch (_) { error(`Clipboard unavailable. Select and copy the ${description.toLowerCase()} manually.`); }
  }
  $('copy-invite').onclick = () => copy($('invite').value,'Invite link');
  $('copy-recovery').onclick = () => copy(state.token,'Private recovery code');
  function download(blob,filename) {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  $('download-recovery').onclick = () => download(new Blob([`PRIVATE SEAT ACCESS — DO NOT SHARE\nRoom: ${state.room.code}\nRecovery code: ${state.token}\nReturn at: ${$('invite').value}\n`],{type:'text/plain'}),`reroll-${state.room.code}-PRIVATE-recovery.txt`);
  for (const format of ['json','csv']) $(`export-${format}`).onclick = async () => {
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(state.code)}/export?format=${format}`,{credentials:'same-origin',cache:'no-store'});
      if (!response.ok) throw new Error('Export failed. Reconnect to your room and try again.');
      download(await response.blob(),`reroll-${state.code}.${format}`);
    } catch (failure) { error(failure.message); }
  };
  try {
    const recent = JSON.parse(localStorage.getItem('reroll-recent-rooms') || '[]');
    if (Array.isArray(recent) && recent.length) {
      $('recent').hidden = false;
      $('recent').innerHTML = `<h2>Recent rooms</h2><ul>${recent.filter(code => typeof code === 'string' && /^[A-Z0-9]{4,12}$/.test(code)).map(code => `<li><a href="online.html?room=${encodeURIComponent(code)}">Room ${esc(code)}</a></li>`).join('')}</ul><p>Only room codes are stored here. Your private credentials are never stored in this list.</p>`;
    }
  } catch (_) { /* Optional storage may be unavailable. */ }
  const invitedCode = new URL(location.href).searchParams.get('room')?.trim().toUpperCase();
  if (invitedCode) {
    $('join').elements.code.value = invitedCode;
    $('recover').elements.code.value = invitedCode;
    api(`/api/rooms/${encodeURIComponent(invitedCode)}`).then(result => accept(result,true)).catch(() => connection('Enter your guest name to join, or use your recovery code to reclaim your saved seat.'));
  }
})();
