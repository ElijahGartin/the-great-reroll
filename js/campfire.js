/* Homepage ambience. Coordinates are in the original 1669 × 942 artwork. */
(() => {
  'use strict';
  const scene = document.createElement('div');
  scene.className = 'gr-campfire-scene';
  scene.setAttribute('aria-hidden', 'true');
  document.body.prepend(scene);
  const canvas = document.createElement('canvas');
  canvas.className = 'gr-campfire';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, previous = 0, elapsed = 0, spawn = 0, smokeSpawn = 0;
  let width = 0, height = 0, scale = 1, offset = 0, offsetY = 0;
  let embers = [], smoke = [];
  const random = (min, max) => min + Math.random() * (max - min);
  function resize() {
    width = innerWidth; height = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Matches background-size: cover; background-position: center bottom; fixed.
    scale = Math.max(width / 1669, height / 942);
    offset = (width - 1669 * scale) / 2;
    offsetY = height - 942 * scale;
  }
  function glow(x, y, rx, ry, color, alpha) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(rx, ry);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, `rgba(${color},${alpha})`);
    gradient.addColorStop(.35, `rgba(${color},${alpha * .5})`);
    gradient.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = gradient; ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  function newSmoke(age = 0) {
    const speed = random(16,22), drift = random(4,8);
    return {x:random(791,806) + drift * age, y:random(748,760) - speed * age,
      age, life:random(5,7), speed, drift,
      phase:random(0,Math.PI * 2), radius:random(5,8)};
  }
  function seedSmoke() {
    // Start with a formed plume rather than asking visitors to wait for it.
    smoke = Array.from({length:8}, (_, i) => newSmoke(i * .6 + .3));
  }
  function atmosphere(dt) {
    // Soft valley haze follows the same artwork coordinates as the fire.
    // Slow overlapping sheets have no hard edges or visible loop reset.
    ctx.globalCompositeOperation = 'source-over';
    const mistBands = [
      [617, 685, 132, 15], [906, 693, 156, 18],
      [1110, 711, 150, 17], [1260, 676, 122, 15]
    ];
    mistBands.forEach(([cx, cy, rx, ry], i) => {
      const phase = elapsed * .12 + i * 1.7;
      const x = cx + Math.sin(phase) * 61;
      const y = cy + Math.sin(phase * .65 + i) * 6;
      glow(x, y, rx, ry, '177,186,192', .105 + .014 * Math.sin(phase + i));
      glow(x - 48, y + 10, rx * .7, ry * .55, '164,179,190', .05);
    });
    smokeSpawn -= dt;
    if (smokeSpawn <= 0 && smoke.length < 12) {
      smoke.push(newSmoke());
      smokeSpawn = random(.65,.85);
    }
    smoke = smoke.filter(p => p.age < p.life);
    for (const p of smoke) {
      p.age += dt;
      const progress = Math.min(p.age / p.life, 1);
      p.y -= p.speed * dt;
      p.x += (p.drift + Math.sin(p.age * .85 + p.phase) * 6) * dt;
      const radius = p.radius + p.age * 1.8;
      const alpha = .065 * Math.min(p.age / .7, 1) * Math.pow(1 - progress, 1.6);
      // Warm at the flame tips, cooling into gray as each wisp expands.
      const warm = Math.max(0, 1 - p.age / 3);
      const color = `${Math.round(155 + warm * 30)},${Math.round(160 - warm * 20)},${Math.round(170 - warm * 60)}`;
      glow(p.x, p.y, radius, radius * 1.55, color, alpha);
      glow(p.x + Math.sin(p.age + p.phase) * radius * .65,
        p.y - radius * .45, radius * .8, radius * 1.1, color, alpha * .25);
    }
  }
  function tick(now) {
    const dt = previous ? Math.min((now - previous) / 1000, .05) : 0;
    previous = now; elapsed += dt;
    ctx.clearRect(0, 0, width, height);
    ctx.save(); ctx.translate(offset, offsetY); ctx.scale(scale, scale);
    atmosphere(dt);
    ctx.globalCompositeOperation = 'screen';
    // Incommensurate rhythms avoid an obvious repeating pulse.
    const flicker = .64 + .14 * Math.sin(elapsed * 6.7) +
      .12 * Math.sin(elapsed * 11.3 + 1) + .10 * Math.sin(elapsed * 19.1 + 2);
    glow(799, 811, 102 + flicker * 9, 108, '255,110,20', .10 + flicker * .12);
    glow(799, 869, 205, 47, '255,124,30', .025 + flicker * .065);
    glow(801, 782, 29, 64 + flicker * 9, '255,182,67', .035 + flicker * .10);
    spawn -= dt;
    if (spawn <= 0 && embers.length < 15) {
      embers.push({x:random(774,827), y:random(785,822), age:0,
        life:random(2.3,4.4), speed:random(24,48), drift:random(-7,8),
        phase:random(0,7), radius:random(.8,1.8)});
      spawn = random(.22,.48);
    }
    embers = embers.filter(e => e.age < e.life);
    for (const e of embers) {
      e.age += dt; e.y -= e.speed * dt;
      e.x += (e.drift + Math.sin(e.age * 2.5 + e.phase) * 10) * dt;
      const alpha = Math.min(e.age * 5, 1) * Math.pow(Math.max(0, 1 - e.age / e.life), 1.2);
      glow(e.x,e.y,e.radius * 4,e.radius * 5,'255,115,24',alpha * .30);
      ctx.fillStyle = `rgba(255,195,95,${alpha * .8})`;
      ctx.beginPath(); ctx.ellipse(e.x,e.y,e.radius,e.radius * 1.5,0,0,Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    const active = document.body.classList.contains('gr-home-view') && !document.hidden && !motion.matches;
    canvas.hidden = !active;
    if (active && !frame) { seedSmoke(); resize(); previous = 0; frame = requestAnimationFrame(tick); }
    if (!active) { cancelAnimationFrame(frame); frame = 0; previous = 0; embers = []; smoke = []; smokeSpawn = 0; }
  }
  new MutationObserver(sync).observe(document.body, {attributes:true, attributeFilter:['class']});
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  addEventListener('resize', resize, {passive:true});
  sync();
})();
