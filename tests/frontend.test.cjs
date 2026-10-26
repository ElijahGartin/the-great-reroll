'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const characterData = require('../data/characters.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/online.js'), 'utf8');
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function room(version = 1, status = 'lobby') {
  return {code:'ABCDEF1234',mode:'draft',version,status,hostId:'alice',participants:[{id:'alice',name:'Alice',ready:false}],config:{faction:'Horde',format:'class',pickTimer:0,requirements:{}},createdAt:1,updatedAt:1,expiresAt:2000000000000,game:status === 'lobby' ? null : {mode:'draft',phase:'draft',faction:'Horde',players:[{id:'alice',name:'Alice'}],order:[0],turn:0,stage:1,offers:[{race:'Orc',cls:'Warrior',key:'Orc|Warrior'}],picks:[],assignments:[],spent:[],rolls:[],config:{},deadline:null}};
}
// A deliberately small DOM adapter exercises the shipped client event handlers
// and fetch boundary without adding a browser dependency to the Node test suite.
function client(fetcher, href = 'http://localhost/online.html', recent = null) {
  const elements = new Map(), timers = new Map(), writes = [], requests = [], urls = [];
  let timerId = 0;
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.hidden = false; this.disabled = false; this.readOnly = false; this.className = ''; this.dataset = {}; this.elements = {}; this.children = []; this.textContent = ''; }
    set innerHTML(html) {
      this.html = html;
      for (const child of this.children) if (child.id) elements.delete(child.id);
      this.children = [];
      for (const match of html.matchAll(/<(input|select|button)\b([^>]*)>/g)) {
        const child = new Element(/\bid="([^"]*)"/.exec(match[2])?.[1] || '');
        child.disabled = /\bdisabled\b/.test(match[2]);
        child.value = decode(/\bvalue="([^"]*)"/.exec(match[2])?.[1] || '');
        const action = /\bdata-action="([^"]*)"/.exec(match[2]);
        if (action) { child.dataset.action = action[1]; child.dataset.payload = decode(/\bdata-payload="([^"]*)"/.exec(match[2])[1]); }
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
      }
    }
    get innerHTML() { return this.html || ''; }
    querySelectorAll(selector) { return selector === '[data-action]' ? this.children.filter(child => child.dataset.action) : selector === 'input[id],select[id]' ? this.children.filter(child => child.id) : this.children; }
    querySelector() { return this.submit ||= new Element(); }
    contains(node) { return this.children.includes(node); }
    focus() { document.activeElement = this; }
    click() { this.onclick?.(); }
    reportValidity() { return true; }
  }
  const document = {hidden:false,activeElement:null,getElementById:id => elements.get(id) || null,addEventListener(){},createElement:() => new Element()};
  for (const id of ['connection','error','retry','entry','session','recovery','recovery-token','invite','room-title','room-description','room-content','draft-settings','deal-settings','requirements','stage-two-options','role-requirements','eligibility','copy-invite','copy-recovery','download-recovery','export-json','export-csv','recent','create','join','recover','join-title','invite-description','invite-room-code','join-code-field','recover-code-field','show-recovery','multiplayer-home']) elements.set(id,new Element(id));
  for (const id of ['create','join','recover']) for (const field of ['name','code','token','mode','format']) elements.get(id).elements[field] = new Element();
  const context = {window:{GR_CHARACTER_DATA:characterData},document,location:{href},history:{replaceState(a,b,url){urls.push(url);}},navigator:{clipboard:{writeText:async () => {}}},localStorage:{getItem(){return recent;},setItem(key,value){writes.push([key,value]);}},crypto:{randomUUID},URL,AbortController,Blob,console,setTimeout(callback,delay){timers.set(++timerId,{callback,delay});return timerId;},clearTimeout(id){timers.delete(id);},setInterval(){},fetch:async (path,options) => {requests.push({path,options});return fetcher(path,options);}};
  vm.runInNewContext(source,context,{filename:'js/online.js'});
  return {elements,writes,requests,urls,async enter(resultStatus = 'lobby') { const form = elements.get('join');form.elements.name.value = 'Alice';form.elements.code.value = 'ABCDEF1234';form.onsubmit({preventDefault(){}});await flush(); },action(type){return elements.get('room-content').children.find(child => child.dataset.action === type);},async poll(){const timer = [...timers.values()].find(timer => timer.delay === 1500);assert.ok(timer,'client schedules room refresh');timer.callback();await flush();}};
}
const response = (value,status = 200) => ({ok:status < 400,status,json:async () => value});

function assertInvitation(c, code = 'ABCDEF1234') {
  assert.equal(c.elements.get('create').hidden,true);
  assert.equal(c.elements.get('recent').hidden,true);
  assert.equal(c.elements.get('join-title').textContent,'Join your party');
  assert.equal(c.elements.get('invite-description').hidden,false);
  assert.equal(c.elements.get('invite-room-code').textContent,code);
  assert.equal(c.elements.get('multiplayer-home').hidden,false);
  for (const id of ['join','recover']) {
    assert.equal(c.elements.get(id).elements.code.value,code);
    assert.equal(c.elements.get(id).elements.code.readOnly,true);
    assert.equal(c.elements.get(`${id}-code-field`).hidden,true);
  }
}

test('ordinary entry keeps create, join and recovery available without requesting a room',async () => {
  const c = client(() => { throw new Error('Unexpected request'); });
  await flush();
  assert.equal(c.requests.length,0);
  assert.equal(c.elements.get('entry').hidden,false);
  for (const id of ['create','join','recover']) assert.equal(c.elements.get(id).hidden,false);
  for (const id of ['join','recover']) {
    assert.equal(c.elements.get(id).elements.code.readOnly,false);
    assert.equal(c.elements.get(`${id}-code-field`).hidden,false);
  }
  assert.equal(c.elements.get('invite-description').hidden,true);
  assert.equal(c.elements.get('show-recovery').hidden,true);
});

test('invite waits for cookie lookup then resumes the existing seat without joining again',async () => {
  let resolveLookup;
  const c = client(() => new Promise(resolve => { resolveLookup = resolve; }), 'http://localhost/online.html?room=abcdef1234');
  assert.equal(c.elements.get('entry').hidden,true);
  assert.equal(c.elements.get('session').hidden,true);
  assertInvitation(c);
  resolveLookup(response({room:room(),participantId:'alice'}));
  await flush();
  assert.equal(c.elements.get('entry').hidden,true);
  assert.equal(c.elements.get('session').hidden,false);
  assert.equal(c.requests.length,1);
  assert.equal(c.requests[0].path,'/api/rooms/ABCDEF1234');
  assert.equal(c.requests[0].options.method,'GET');
});

for (const status of [401,403]) test(`invite lookup ${status} shows only guest join and optional seat recovery`,async () => {
  const c = client(() => response({error:'Seat access required'},status), 'http://localhost/online.html?room=abcdef1234', '["OTHER12345"]');
  await flush();
  assertInvitation(c);
  assert.equal(c.elements.get('entry').hidden,false);
  assert.equal(c.elements.get('recover').hidden,true);
  assert.equal(c.elements.get('join').querySelector('button').disabled,false);
  c.elements.get('show-recovery').click();
  assert.equal(c.elements.get('recover').hidden,false);
  c.elements.get('show-recovery').click();
  assert.equal(c.elements.get('recover').hidden,true);
});

test('invite request failures retain the invitation view and show an actionable error',async () => {
  const c = client(() => { throw new TypeError('Network interrupted'); }, 'http://localhost/online.html?room=ABCDEF1234');
  await flush();
  assertInvitation(c);
  assert.equal(c.elements.get('entry').hidden,false);
  assert.equal(c.elements.get('error').hidden,false);
  assert.match(c.elements.get('error').textContent,/Network interrupted/);
});

test('invited guest joins the supplied room using only their name',async () => {
  const c = client(path => path.endsWith('/join') ? response({room:room(),participantId:'alice'}) : response({error:'Seat access required'},401), 'http://localhost/online.html?room=abcdef1234');
  await flush();
  const form = c.elements.get('join');
  form.elements.name.value = ' Alice ';
  form.onsubmit({preventDefault(){}});
  await flush();
  assert.equal(c.requests.length,2);
  assert.equal(c.requests[1].path,'/api/rooms/ABCDEF1234/join');
  assert.deepEqual(JSON.parse(c.requests[1].options.body),{name:'Alice'});
  assert.equal(c.elements.get('entry').hidden,true);
  assert.equal(c.elements.get('session').hidden,false);
});

test('invite recovery submits the private code to the supplied room and clears the field',async () => {
  const token = 'private-seat-access-token';
  const c = client(path => path.endsWith('/resume') ? response({room:room(),participantId:'alice'}) : response({error:'Seat access required'},401), 'http://localhost/online.html?room=abcdef1234');
  await flush();
  c.elements.get('show-recovery').click();
  const form = c.elements.get('recover');
  form.elements.token.value = token;
  form.onsubmit({preventDefault(){}});
  await flush();
  assert.equal(c.requests[1].path,'/api/rooms/ABCDEF1234/resume');
  assert.deepEqual(JSON.parse(c.requests[1].options.body),{token});
  assert.equal(form.elements.token.value,'');
  assert.equal(c.elements.get('session').hidden,false);
  assert.ok(c.urls.every(url => !url.includes(token)));
  assert.ok(c.writes.every(([,value]) => !value.includes(token)));
});

for (const code of ['', 'bad', '%3Cscript%3E', 'ABCDEFGHIJK']) test(`invalid invite ${JSON.stringify(code)} cannot issue room requests`,async () => {
  const c = client(() => { throw new Error('Unexpected request'); }, `http://localhost/online.html?room=${code}`);
  await flush();
  assert.equal(c.requests.length,0);
  assert.equal(c.elements.get('entry').hidden,false);
  assert.equal(c.elements.get('create').hidden,true);
  assert.equal(c.elements.get('recent').hidden,true);
  assert.equal(c.elements.get('recover').hidden,true);
  assert.equal(c.elements.get('join').querySelector('button').disabled,true);
  assert.match(c.elements.get('connection').textContent,/invalid/i);
  assert.match(c.elements.get('error').textContent,/invite link/i);
  c.elements.get('join').elements.name.value = 'Guest';
  c.elements.get('join').onsubmit({preventDefault(){}});
  await flush();
  assert.equal(c.requests.length,0);
});

for (const status of [401,404,410]) test(`poll ${status} returns to invite entry with its room retained`,async () => {
  let requests = 0;
  const c = client(() => ++requests === 1 ? response({room:room(),participantId:'alice'}) : response({error:'Room unavailable'},status), 'http://localhost/online.html?room=ABCDEF1234');
  await flush();
  await c.poll();
  assertInvitation(c);
  assert.equal(c.elements.get('entry').hidden,false);
  assert.equal(c.elements.get('session').hidden,true);
  assert.equal(c.elements.get('recover').hidden,true);
});

test('invited guest lobby confirms membership and keeps host actions exclusive to the host',async () => {
  const party = room();
  party.participants.push({id:'bob',name:'Bob',ready:false});
  const guest = client(() => response({room:party,participantId:'bob'}), 'http://localhost/online.html?room=ABCDEF1234');
  const host = client(() => response({room:party,participantId:'alice'}), 'http://localhost/online.html?room=ABCDEF1234');
  await flush();
  assert.match(guest.elements.get('room-content').innerHTML,/You(?:’|'|&#39;)re in the party/);
  assert.ok(guest.action('ready'));
  for (const action of ['start','transfer-host','remove-player']) {
    assert.equal(guest.action(action),undefined);
    assert.ok(host.action(action));
  }
});

test('joining persists only public room codes and keeps recovery credentials out of URLs',async () => {
  const token = 'private-seat-access-token';
  const c = client(() => response({room:room(),participantId:'alice',token}));
  await c.enter();
  assert.equal(c.elements.get('recovery-token').value,token);
  assert.equal(c.elements.get('recovery').hidden,false);
  assert.ok(c.writes.length);
  for (const [key,value] of c.writes) { assert.equal(key,'reroll-recent-rooms');assert.deepEqual(JSON.parse(value),['ABCDEF1234']);assert.ok(!value.includes(token)); }
  assert.ok(c.urls.every(url => url === '/online.html?room=ABCDEF1234'));
  assert.equal(c.requests[0].options.credentials,'same-origin');
});

test('network retry reuses the exact command and id instead of applying the action twice',async () => {
  let attempts = 0;
  const c = client(path => {
    if (path.endsWith('/join')) return response({room:room(),participantId:'alice'});
    if (++attempts === 1) throw new TypeError('Network interrupted');
    return response({room:room(2),participantId:'alice'});
  });
  await c.enter();c.action('ready').click();await flush();
  assert.equal(c.elements.get('retry').hidden,false);
  c.elements.get('retry').click();await flush();
  const commands = c.requests.filter(r => r.path.endsWith('/actions'));
  assert.equal(commands.length,2);
  assert.equal(commands[0].options.body,commands[1].options.body);
  assert.equal(JSON.parse(commands[0].options.body).version,1);
  assert.equal(c.elements.get('retry').hidden,true);
});

test('a version conflict refreshes the room and requires a fresh explicit action',async () => {
  const c = client(path => path.endsWith('/join') ? response({room:room(),participantId:'alice'}) : path.endsWith('/actions') ? response({error:'Version conflict'},409) : response({room:room(3),participantId:'alice'}));
  await c.enter();c.action('ready').click();await flush();
  assert.equal(c.requests.filter(r => r.path.endsWith('/actions')).length,1);
  assert.match(c.elements.get('error').textContent,/Review the current turn/);
  assert.equal(c.elements.get('retry').hidden,true);
  c.action('ready').click();await flush();
  const commands = c.requests.filter(r => r.path.endsWith('/actions')).map(r => JSON.parse(r.options.body));
  assert.notEqual(commands[0].id,commands[1].id);
  assert.equal(commands[1].version,3);
});

test('room refresh preserves focused name edits and ignores older versions',async () => {
  let next = room(1,'playing');
  const c = client(() => response({room:structuredClone(next),participantId:'alice'}));
  await c.enter();
  const input = c.elements.get('character-name');input.value = 'Thrall';input.focus();
  next = room(2,'playing');await c.poll();
  assert.equal(c.elements.get('character-name').value,'Thrall');
  const rendered = c.elements.get('room-content').innerHTML;
  next = room(1,'playing');next.game.players[0].name = 'Stale turn';await c.poll();
  assert.equal(c.elements.get('room-content').innerHTML,rendered);
  c.action('pick').click();await flush();
  const command = JSON.parse(c.requests.find(r => r.path.endsWith('/actions')).options.body);
  assert.equal(command.payload.name,'Thrall');
  assert.equal(command.version,2);
});


test('untrusted guest names stay text in Deal Everyone headings and history',async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const next = room(1,'playing');next.mode = 'deal';
  next.game = {phase:'steal',faction:'Horde',players:[{id:'alice',name:hostile,hand:[{race:'Orc',cls:'Warrior',key:'Orc|Warrior'}],defense:[0],reserve:50,choice:null}],order:[0],turn:0,budget:50,attempts:1,submissions:{},log:[hostile]};
  const c = client(() => response({room:next,participantId:'alice'}));
  await c.enter();
  const html = c.elements.get('room-content').innerHTML;
  assert.ok(!html.includes(hostile));
  assert.match(html,/Steal round · &lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a successful old retry receipt unlocks controls on the latest room version',async () => {
  let attempts = 0;
  const c = client(path => {
    if (path.endsWith('/join')) return response({room:room(1,'playing'),participantId:'alice'});
    if (path.endsWith('/actions')) {
      if (++attempts === 1) throw new TypeError('Network interrupted');
      return response({room:room(2,'playing'),participantId:'alice'});
    }
    return response({room:room(3,'playing'),participantId:'alice'});
  });
  await c.enter();c.action('spin').click();await flush();
  await c.poll();assert.equal(c.action('pick').disabled,true);
  c.elements.get('retry').click();await flush();
  assert.equal(c.action('pick').disabled,false);
});
