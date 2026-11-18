(() => {
'use strict';
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');

// ---- tuning ----
const G = 1900;
const R = 13;
const SPEAR_LEN = 82;
const FLOOR = 64;
const V_NORMAL = Math.sqrt(2 * G * 240);
const V_PERFECT = Math.sqrt(2 * G * 410);
const PERFECT_WIN = 0.32;
const LAUNCH_FRAC = 0.7;
const FLY = 0.12;
const COOLDOWN = 0.12;

let W, H, DPR, wallX, ballX;
function resize(){
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  // 大きさは canvas そのもの (100vh の根っこいっぱい) から取る。iOS のホーム画面では innerHeight が安全域ぶん足りないことがある
  W = cv.clientWidth || window.innerWidth; H = cv.clientHeight || window.innerHeight;
  if (!(W >= 1 && H >= 1)) return;   // 一瞬 0 で渡ってくることがある (CLAUDE.md の落とし穴)
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  wallX = Math.round(W / 2 - 42);
  ballX = wallX + 44;
}
window.addEventListener('resize', resize);
resize();

// ---- storage ----
let best = { floors: 0, y: 0 };
try {
  const s = localStorage.getItem('yarinobori-best');
  if (s) { const p = JSON.parse(s); if (p && typeof p.floors === 'number') best = p; }
} catch (e) {}
function saveBest(){ try { localStorage.setItem('yarinobori-best', JSON.stringify(best)); } catch (e) {} }
let save = { coins: 0, owned: ['orange'], equip: 'orange' };
try {
  const s = localStorage.getItem('yarinobori-save');
  if (s) { const p = JSON.parse(s); if (p && Array.isArray(p.owned)) save = Object.assign(save, p); }
} catch (e) {}
function saveSave(){ try { localStorage.setItem('yarinobori-save', JSON.stringify(save)); } catch (e) {} }

// ---- audio ----
let ac = null;
function ensureAudio(){
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } }
  if (ac && ac.state === 'suspended') ac.resume();
}
function tone(freq, dur, type, vol, slideTo){
  if (!ac) return;
  const t0 = ac.currentTime;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(dur, vol, freq){
  if (!ac) return;
  const t0 = ac.currentTime;
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource(); src.buffer = buf;
  const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = ac.createGain(); g.gain.value = vol;
  src.connect(f).connect(g).connect(ac.destination); src.start(t0);
}
const snd = {
  pock(perfect){ tone(perfect ? 2300 : 1750, 0.05, 'sine', 0.32); tone(perfect ? 3500 : 2600, 0.03, 'sine', 0.12);
    if (perfect) setTimeout(() => tone(1560, 0.12, 'triangle', 0.14, 2340), 40); },
  ground(){ tone(1500, 0.05, 'sine', 0.22); },
  thunk(){ noise(0.07, 0.55, 1100); tone(150, 0.09, 'triangle', 0.35, 80); },
  glass(){ tone(3300, 0.18, 'triangle', 0.16); tone(4900, 0.14, 'sine', 0.1); },
  whoosh(){ noise(0.1, 0.22, 2600); },
  over(){ tone(620, 0.45, 'sine', 0.25, 160); }
};

// ---- state ----
let state = 'title';
let t, ball, camY, spears, debris, pops, flying, lastShot, maxY, shake, trail, bounces;

const rand = (a, b) => a + Math.random() * (b - a);

function reset(){
  t = 0;
  ball = { y: R, vy: V_NORMAL, sq: 0 };
  camY = 110 - H * (1 - LAUNCH_FRAC); spears = []; debris = []; pops = []; trail = [];
  flying = []; lastShot = -1; maxY = 0; shake = 0; bounces = 0;
  updateHud();
}
const floorsOf = y => 1 + Math.floor(Math.max(0, y) / FLOOR);
function spearX(k){ const xs = W - SPEAR_LEN - 12, xe = wallX - 3; return xs + (xe - xs) * k; }
function spearHitsBall(x, y){
  const cx = Math.max(x - 15, Math.min(ballX, x + SPEAR_LEN)) - ballX;
  const dy = y - ball.y;
  return cx * cx + dy * dy < (R + 2.5) * (R + 2.5);
}
function hitBall(){
  ball.sq = 1;
  pops.push({ x: ballX + 22, y: ball.y + 24, text: 'あたった！', life: 1, col: '#ffd0d0' });
  tone(900, 0.06, 'square', 0.12);
  gameOver();
}

// ---- HUD ----
const numEl = document.getElementById('num');
const bestHud = document.getElementById('bestHud');
let lastFloors = -1;
function updateHud(){
  const f = floorsOf(maxY);
  if (f !== lastFloors) { numEl.textContent = f; lastFloors = f; }
  bestHud.textContent = 'さいこう ' + best.floors + 'かい';
  coinHud.textContent = save.coins + (state === 'play' ? floorsOf(maxY) : 0);
}
const coinHud = document.getElementById('coinHud');

// ---- input ----
cv.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (state !== 'play') return;
  ensureAudio();
  if (t - lastShot < COOLDOWN) return;
  lastShot = t;
  flying.push({ y: camY + H * (1 - LAUNCH_FRAC), t0: t });
  snd.whoosh();
}, { passive: false });

// ---- physics ----
function step(dt){
  t += dt;
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i];
    const k = Math.min(1, (t - f.t0) / FLY);
    if (state === 'play' && spearHitsBall(spearX(k), f.y)) { hitBall(); return; }
    if (k >= 1) {
      flying.splice(i, 1);
      spears.push({ y: f.y, born: t });
      snd.thunk();
    }
  }

  const prevBot = ball.y - R;
  ball.vy -= G * dt;
  ball.y += ball.vy * dt;
  const bot = ball.y - R;

  if (ball.vy < 0) {
    let hit = null;
    for (const s of spears) {
      if (prevBot >= s.y - 0.01 && bot <= s.y && (!hit || s.y > hit.y)) hit = s;
    }
    if (hit) {
      ball.y = hit.y + R;
      ball.vy = V_NORMAL;
      ball.sq = 1;
      if (!hit.used) { hit.used = true; bounces++; }
      snd.pock(false);
    } else if (bot <= 0 && prevBot >= 0) {
      ball.y = R; ball.vy = V_NORMAL; ball.sq = 1;
      snd.ground();
    }
  }

  if (state === 'play') {
    if (ball.y > maxY) { maxY = ball.y; updateHud(); }
    const target = ball.y - H * 0.42;
    if (target > camY) camY += (target - camY) * Math.min(1, dt * 6);
    if (ball.y + R < camY - 30) gameOver();
  }

  spears = spears.filter(s => s.y > camY - 60);
  for (const d of debris) { d.vy -= G * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt; }
  debris = debris.filter(d => d.y > camY - 200);
  for (const p of pops) { p.life -= dt; p.y += 50 * dt; }
  pops = pops.filter(p => p.life > 0);
  ball.sq = Math.max(0, ball.sq - dt * 7);
  shake = Math.max(0, shake - dt);
}

// ---- drawing helpers ----
const sy = wy => H - (wy - camY);
function hex(h){ const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function mix(a, b, k){ const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`; }
const SKY = [
  { at: 0,    top: '#5fb8ea', bot: '#d6f1fb' },
  { at: 2600, top: '#3d86d6', bot: '#9fd6f2' },
  { at: 5200, top: '#3a3f9a', bot: '#f2a07a' },
  { at: 8000, top: '#0f1240', bot: '#3a2f6e' }
];
function skyAt(alt){
  for (let i = 0; i < SKY.length - 1; i++) {
    const a = SKY[i], b = SKY[i + 1];
    if (alt <= b.at) { const k = Math.max(0, (alt - a.at) / (b.at - a.at)); return [mix(a.top, b.top, k), mix(a.bot, b.bot, k)]; }
  }
  const l = SKY[SKY.length - 1]; return [l.top, l.bot];
}
function hash(n){ const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

function drawSky(){
  const [top, bot] = skyAt(camY);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top); g.addColorStop(1, bot);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  const starA = Math.min(1, Math.max(0, (camY - 5800) / 2000));
  if (starA > 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.8 * starA})`;
    const py = camY * 0.15;
    for (let i = 0; i < 70; i++) {
      const x = hash(i) * W, y = ((hash(i + 99) * H * 1.5 + py) % (H * 1.5)) - H * 0.25;
      const s = hash(i + 7) < 0.15 ? 2 : 1.2;
      ctx.fillRect(x, y, s, s);
    }
  }

  // clouds (parallax)
  const P = 0.55, GAP = 380;
  const k0 = Math.floor((camY * P - 200) / GAP), k1 = Math.ceil((camY * P + H + 200) / GAP);
  const ca = 1 - Math.min(0.75, Math.max(0, (camY - 5000) / 3000));
  for (let k = k0; k <= k1; k++) {
    if (k < 1) continue;
    const cy = H - (k * GAP - camY * P);
    const cx = (0.15 + hash(k) * 0.9) * W;
    const sc = 0.7 + hash(k + 3) * 0.7;
    ctx.fillStyle = `rgba(255,255,255,${0.78 * ca})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 46 * sc, 16 * sc, 0, 0, Math.PI * 2);
    ctx.ellipse(cx - 22 * sc, cy - 8 * sc, 22 * sc, 16 * sc, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 14 * sc, cy - 14 * sc, 26 * sc, 20 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGround(){
  const gy = sy(0);
  if (gy > H + 10) return;
  ctx.fillStyle = '#9aa3a8'; ctx.fillRect(0, gy, W, 10);
  ctx.fillStyle = '#4b5158'; ctx.fillRect(0, gy + 10, W, H);
  ctx.fillStyle = '#f2f2ea';
  for (let x = wallX + 30; x < W; x += 60) ctx.fillRect(x, gy + 40, 30, 5);
}

function drawBuilding(){
  const top = 0, bottom = Math.min(H, sy(0));
  if (bottom <= 0) return;
  ctx.fillStyle = '#c4bdb0';
  ctx.fillRect(0, top, wallX, bottom - top);

  // floors & windows
  const f0 = Math.max(0, Math.floor(camY / FLOOR)), f1 = Math.ceil((camY + H) / FLOOR);
  const cols = Math.max(1, Math.floor((wallX - 24) / 58));
  for (let f = f0; f <= f1; f++) {
    const yBase = f * FLOOR;
    const ly = sy(yBase);
    ctx.fillStyle = '#ada597'; ctx.fillRect(0, ly - 3, wallX, 3);
    for (let c = 0; c < cols; c++) {
      const x = wallX - 38 - c * 58;
      if (x < 6) break;
      const wy = ly - FLOOR + 16;
      ctx.fillStyle = '#5f7685'; ctx.fillRect(x, wy, 26, 32);
      ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect(x + 3, wy + 3, 6, 26);
      ctx.fillStyle = '#d9d3c7'; ctx.fillRect(x - 2, wy + 32, 30, 3);
    }
  }

  // facade edge (corner shading)
  ctx.fillStyle = '#9c9487'; ctx.fillRect(wallX - 7, top, 7, bottom - top);
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(wallX - 9, top, 2, bottom - top);
}

function drawBestLine(){
  if (best.y <= 0) return;
  const y = sy(best.y);
  if (y < -20 || y > H + 20) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(230,60,60,.85)'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#e63c3c';
  ctx.font = '700 12px "Hiragino Sans",sans-serif';
  ctx.fillText('さいこう', 8, y - 6);
}

function drawSpear(x0, y, len, glow){
  // shaft
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#8b5a2b'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + len, y); ctx.stroke();
  ctx.strokeStyle = '#b8814a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, y - 1.5); ctx.lineTo(x0 + len, y - 1.5); ctx.stroke();
  // butt cap + tassel
  ctx.fillStyle = '#3a2a1c'; ctx.fillRect(x0 + len - 6, y - 3.5, 7, 7);
  ctx.fillStyle = '#d8402f';
  ctx.beginPath(); ctx.moveTo(x0 + len - 10, y + 2); ctx.lineTo(x0 + len - 16, y + 12); ctx.lineTo(x0 + len - 6, y + 11); ctx.fill();
  if (glow > 0) {
    ctx.strokeStyle = `rgba(255,248,180,${glow})`; ctx.lineWidth = 11;
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + len, y); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawSpearTip(x0, y){
  drawSpear(x0, y, SPEAR_LEN, 0);
  ctx.fillStyle = '#7d878e';
  ctx.beginPath(); ctx.moveTo(x0, y - 4.5); ctx.lineTo(x0 - 15, y); ctx.lineTo(x0, y + 4.5); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.beginPath(); ctx.moveTo(x0, y - 4.5); ctx.lineTo(x0 - 15, y); ctx.lineTo(x0, y - 1); ctx.fill();
}

function drawLauncher(){
  if (state === 'over') return;
  const y = H * LAUNCH_FRAC;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2; ctx.setLineDash([3, 7]);
  ctx.beginPath(); ctx.moveTo(wallX, y); ctx.lineTo(W - SPEAR_LEN - 30, y); ctx.stroke();
  ctx.restore();
  // bracket
  ctx.fillStyle = 'rgba(40,55,70,.35)';
  ctx.fillRect(W - SPEAR_LEN - 8, y + 5, SPEAR_LEN + 8, 6);
  ctx.fillRect(W - 18, y - 10, 6, 21);
  const ready = t - lastShot >= COOLDOWN + 0.06;
  if (ready) drawSpearTip(W - SPEAR_LEN - 12, y);

  // first-time guide
  if (state === 'play' && bounces < 3) {
    const lineW = camY + H * (1 - LAUNCH_FRAC);
    const b = ball.y - R;
    const bf = b + ball.vy * FLY - 0.5 * G * FLY * FLY;
    const now = ball.vy < 0 && bf > lineW + 8 && b < lineW + 220;
    ctx.textAlign = 'center';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(25,40,60,.6)';
    ctx.font = '15px "Dela Gothic One","Hiragino Sans",sans-serif';
    ctx.fillStyle = '#ffffff';
    const msg = '玉が点線より上にあるときにタップ';
    ctx.strokeText(msg, W / 2, y + 46); ctx.fillText(msg, W / 2, y + 46);
    if (now) {
      const s = 1 + 0.12 * Math.sin(t * 20);
      ctx.save();
      ctx.translate(W - SPEAR_LEN / 2 - 12, y - 32); ctx.scale(s, s);
      ctx.font = '32px "Dela Gothic One","Hiragino Sans",sans-serif';
      ctx.lineWidth = 6;
      ctx.strokeText('いま！', 0, 0);
      ctx.fillStyle = '#fff3a6'; ctx.fillText('いま！', 0, 0);
      ctx.restore();
    }
    ctx.textAlign = 'left';
  }
}

function drawSpears(){
  for (const s of spears) {
    const y = sy(s.y);
    if (y < -20 || y > H + 20) continue;
    const age = t - s.born;
    const a = Math.min(1, age / 0.07);
    const off = (1 - a) * (W - wallX);
    if (a >= 1) {
      ctx.strokeStyle = 'rgba(70,60,50,.55)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(wallX - 2, y); ctx.lineTo(wallX - 12, y - 7);
      ctx.moveTo(wallX - 2, y); ctx.lineTo(wallX - 10, y + 8);
      ctx.moveTo(wallX - 2, y); ctx.lineTo(wallX - 15, y + 1);
      ctx.stroke();
    }
    const glow = 0;
    drawSpear(wallX - 3 + off, y, SPEAR_LEN, glow);
  }
  for (const f of flying) {
    const k = Math.min(1, (t - f.t0) / FLY);
    drawSpearTip(spearX(k), sy(f.y));
  }
  for (const d of debris) {
    const y = sy(d.y);
    ctx.save(); ctx.translate(d.x, y); ctx.rotate(d.rot);
    drawSpear(-SPEAR_LEN / 2, 0, SPEAR_LEN, 0);
    ctx.fillStyle = '#7d878e';
    ctx.beginPath(); ctx.moveTo(-SPEAR_LEN / 2, -4); ctx.lineTo(-SPEAR_LEN / 2 - 14, 0); ctx.lineTo(-SPEAR_LEN / 2, 4); ctx.fill();
    ctx.restore();
  }
}

// ---- ball skins ----
const TAU = Math.PI * 2;
function ballBase(c, r, a, b, d){
  const g = c.createRadialGradient(-r * .3, -r * .38, r * .12, 0, 0, r);
  g.addColorStop(0, a); g.addColorStop(.5, b); g.addColorStop(1, d);
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
}
function gloss(c, r, a){
  c.fillStyle = `rgba(255,255,255,${a})`;
  c.beginPath(); c.ellipse(-r * .36, -r * .42, r * .28, r * .16, -0.6, 0, TAU); c.fill();
}
function clipBall(c, r){ c.beginPath(); c.arc(0, 0, r, 0, TAU); c.clip(); }
function shade(c, r){
  const g = c.createRadialGradient(-r * .3, -r * .38, r * .2, 0, 0, r);
  g.addColorStop(0, 'rgba(255,255,255,.2)'); g.addColorStop(.6, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.3)');
  c.fillStyle = g; c.fillRect(-r, -r, 2 * r, 2 * r);
}
function poly(c, x, y, rad, n, rot){
  c.beginPath();
  for (let i = 0; i < n; i++) { const a = rot + i * TAU / n; c.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); }
  c.closePath();
}
const solid = (a, b, d) => (c, r) => { ballBase(c, r, a, b, d); gloss(c, r, .35); };
const SKINS = [
  { id: 'orange', name: 'オレンジ', r: 'N', draw: solid('#ffd2a6', '#ff8a24', '#e0640d') },
  { id: 'white',  name: 'しろ',     r: 'N', draw: solid('#ffffff', '#f1efe8', '#c9c3b5') },
  { id: 'yellow', name: 'きいろ',   r: 'N', draw: solid('#fff6b8', '#ffd83a', '#cf9f00') },
  { id: 'sky',    name: 'みずいろ', r: 'N', draw: solid('#e4f7ff', '#6cc7f0', '#2f8fc0') },
  { id: 'pink',   name: 'ピンク',   r: 'N', draw: solid('#ffe0ec', '#ff8fb8', '#d9578a') },
  { id: 'suika',  name: 'すいか',   r: 'R', draw(c, r){
    ballBase(c, r, '#bfe8a0', '#3fa34d', '#1f6b2c');
    c.save(); clipBall(c, r);
    c.strokeStyle = '#17501f'; c.lineWidth = r * .16; c.lineJoin = 'round';
    for (const x of [-r * .62, 0, r * .62]) {
      c.beginPath(); let k = 0;
      for (let y = -r; y <= r + 0.1; y += r * .25) { c.lineTo(x + (k++ % 2 ? r * .08 : -r * .08), y); }
      c.stroke();
    }
    shade(c, r); c.restore(); gloss(c, r, .3);
  } },
  { id: 'basket', name: 'バスケ',   r: 'R', draw(c, r){
    ballBase(c, r, '#ffc08a', '#e8772a', '#a94f12');
    c.save(); clipBall(c, r);
    c.strokeStyle = '#2b1a10'; c.lineWidth = r * .09;
    c.beginPath(); c.moveTo(0, -r); c.lineTo(0, r); c.moveTo(-r, 0); c.lineTo(r, 0); c.stroke();
    c.beginPath(); c.arc(-r * 1.35, 0, r * 1.05, -0.9, 0.9); c.stroke();
    c.beginPath(); c.arc(r * 1.35, 0, r * 1.05, Math.PI - 0.9, Math.PI + 0.9); c.stroke();
    c.restore(); gloss(c, r, .25);
  } },
  { id: 'soccer', name: 'サッカー', r: 'R', draw(c, r){
    ballBase(c, r, '#ffffff', '#f3f3f3', '#b8b8b8');
    c.save(); clipBall(c, r);
    c.fillStyle = '#222'; c.strokeStyle = '#222'; c.lineWidth = r * .06;
    poly(c, 0, 0, r * .36, 5, -Math.PI / 2); c.fill();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * TAU / 5;
      c.beginPath(); c.moveTo(Math.cos(a) * r * .36, Math.sin(a) * r * .36); c.lineTo(Math.cos(a) * r * .72, Math.sin(a) * r * .72); c.stroke();
      const b = a + Math.PI / 5;
      poly(c, Math.cos(b) * r * 1.02, Math.sin(b) * r * 1.02, r * .34, 5, b + Math.PI); c.fill();
    }
    shade(c, r); c.restore(); gloss(c, r, .35);
  } },
  { id: 'biidama', name: 'ビー玉', r: 'R', draw(c, r){
    c.save(); clipBall(c, r);
    const g = c.createRadialGradient(-r * .3, -r * .35, r * .1, 0, 0, r);
    g.addColorStop(0, 'rgba(235,250,255,.95)'); g.addColorStop(.6, 'rgba(140,210,245,.8)'); g.addColorStop(1, 'rgba(40,120,190,.9)');
    c.fillStyle = g; c.fillRect(-r, -r, 2 * r, 2 * r);
    c.lineWidth = r * .16; c.lineCap = 'round';
    c.strokeStyle = '#ff5a6e'; c.beginPath(); c.moveTo(-r * .7, r * .3); c.bezierCurveTo(-r * .2, -r * .5, r * .2, r * .6, r * .7, -r * .3); c.stroke();
    c.strokeStyle = '#ffd43b'; c.beginPath(); c.moveTo(-r * .6, -r * .2); c.bezierCurveTo(-r * .1, r * .5, r * .3, -r * .5, r * .6, r * .35); c.stroke();
    c.restore(); gloss(c, r, .75);
  } },
  { id: 'smile', name: 'にこにこ', r: 'SR', draw(c, r){
    ballBase(c, r, '#fff6b8', '#ffd23a', '#d39b00');
    c.fillStyle = 'rgba(255,120,120,.45)';
    c.beginPath(); c.ellipse(-r * .55, r * .2, r * .16, r * .1, 0, 0, TAU); c.ellipse(r * .55, r * .2, r * .16, r * .1, 0, 0, TAU); c.fill();
    c.fillStyle = '#3a2a10';
    c.beginPath(); c.ellipse(-r * .3, -r * .2, r * .1, r * .16, 0, 0, TAU); c.ellipse(r * .3, -r * .2, r * .1, r * .16, 0, 0, TAU); c.fill();
    c.strokeStyle = '#3a2a10'; c.lineWidth = r * .1; c.lineCap = 'round';
    c.beginPath(); c.arc(0, r * .02, r * .45, Math.PI * .2, Math.PI * .8); c.stroke();
    gloss(c, r, .3);
  } },
  { id: 'neko', name: 'ねこ', r: 'SR', draw(c, r){
    c.fillStyle = '#e08a3a';
    c.beginPath(); c.moveTo(-r * .95, -r * .2); c.lineTo(-r * .75, -r * 1.12); c.lineTo(-r * .15, -r * .9); c.fill();
    c.beginPath(); c.moveTo(r * .95, -r * .2); c.lineTo(r * .75, -r * 1.12); c.lineTo(r * .15, -r * .9); c.fill();
    c.fillStyle = '#ffb0b8';
    c.beginPath(); c.moveTo(-r * .78, -r * .45); c.lineTo(-r * .7, -r * .92); c.lineTo(-r * .38, -r * .78); c.fill();
    c.beginPath(); c.moveTo(r * .78, -r * .45); c.lineTo(r * .7, -r * .92); c.lineTo(r * .38, -r * .78); c.fill();
    ballBase(c, r, '#ffe0b5', '#f3a24f', '#c06a1f');
    c.strokeStyle = '#a5541a'; c.lineWidth = r * .08; c.lineCap = 'round';
    c.beginPath(); for (const x of [-r * .18, 0, r * .18]) { c.moveTo(x, -r * .9); c.lineTo(x, -r * .62); } c.stroke();
    c.fillStyle = '#2b1a10';
    c.beginPath(); c.ellipse(-r * .33, -r * .1, r * .08, r * .15, 0, 0, TAU); c.ellipse(r * .33, -r * .1, r * .08, r * .15, 0, 0, TAU); c.fill();
    c.fillStyle = '#ff7f8f'; c.beginPath(); c.moveTo(-r * .09, r * .12); c.lineTo(r * .09, r * .12); c.lineTo(0, r * .22); c.fill();
    c.strokeStyle = '#5a3415'; c.lineWidth = r * .04;
    c.beginPath();
    c.moveTo(-r * .4, r * .2); c.lineTo(-r * .92, r * .12); c.moveTo(-r * .4, r * .28); c.lineTo(-r * .9, r * .36);
    c.moveTo(r * .4, r * .2); c.lineTo(r * .92, r * .12); c.moveTo(r * .4, r * .28); c.lineTo(r * .9, r * .36);
    c.stroke();
    gloss(c, r, .25);
  } },
  { id: 'chikyu', name: 'ちきゅう', r: 'SR', draw(c, r){
    ballBase(c, r, '#bfe6ff', '#2f86d6', '#16508f');
    c.save(); clipBall(c, r);
    c.fillStyle = '#4cae4c';
    c.beginPath(); c.ellipse(-r * .35, -r * .25, r * .38, r * .25, .4, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(r * .35, r * .3, r * .3, r * .42, -.3, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(r * .5, -r * .55, r * .2, r * .12, 0, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,255,255,.7)';
    c.beginPath(); c.ellipse(-r * .2, r * .5, r * .4, r * .08, -.2, 0, TAU); c.fill();
    shade(c, r); c.restore(); gloss(c, r, .3);
  } },
  { id: 'gold', name: 'きんの玉', r: 'SSR', draw(c, r){
    ballBase(c, r, '#fff6c4', '#f1c232', '#9c7000');
    gloss(c, r, .6);
    const x = r * .45, y = -r * .5, s = r * .38;
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(x, y - s); c.quadraticCurveTo(x, y, x + s, y); c.quadraticCurveTo(x, y, x, y + s);
    c.quadraticCurveTo(x, y, x - s, y); c.quadraticCurveTo(x, y, x, y - s); c.fill();
  } },
  { id: 'niji', name: 'にじ', r: 'SSR', draw(c, r){
    c.save(); clipBall(c, r);
    c.save(); c.rotate(-0.45);
    const cols = ['#ff5a5a', '#ffa43b', '#ffe14d', '#5ccf6a', '#4aa8ff', '#8a6cff'];
    cols.forEach((col, i) => { c.fillStyle = col; c.fillRect(-r * 1.6, -r * 1.5 + i * r * .5, r * 3.2, r * .52); });
    c.restore();
    shade(c, r); c.restore(); gloss(c, r, .45);
  } }
];
const skinById = id => SKINS.find(s => s.id === id) || SKINS[0];

function drawBall(){
  const y = sy(ball.y);
  trail.push(y); if (trail.length > 6) trail.shift();
  for (let i = 0; i < trail.length - 1; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.09 * (i + 1)})`;
    ctx.beginPath(); ctx.arc(ballX, trail[i], R * (0.6 + i * 0.06), 0, Math.PI * 2); ctx.fill();
  }
  const sx = 1 + 0.28 * ball.sq, syy = 1 - 0.28 * ball.sq;
  ctx.save();
  ctx.translate(ballX, y + R * (1 - syy));
  ctx.scale(sx, syy);
  skinById(save.equip).draw(ctx, R);
  ctx.restore();
}

function drawPops(){
  ctx.textAlign = 'left';
  ctx.font = '20px "Dela Gothic One","Hiragino Sans",sans-serif';
  for (const p of pops) {
    const a = Math.min(1, p.life * 2.5);
    ctx.globalAlpha = a;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(25,40,60,.55)';
    ctx.strokeText(p.text, p.x, sy(p.y));
    ctx.fillStyle = p.col; ctx.fillText(p.text, p.x, sy(p.y));
  }
  ctx.globalAlpha = 1;
}

function render(){
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * 6 * shake / 0.18, (Math.random() - 0.5) * 6 * shake / 0.18);
  drawSky();
  drawGround();
  drawBuilding();
  drawBestLine();
  drawSpears();
  drawLauncher();
  drawBall();
  drawPops();
  ctx.restore();
}

// ---- flow ----
const titleOv = document.getElementById('titleOv');
const overOv = document.getElementById('overOv');
function start(){
  ensureAudio();
  reset();
  state = 'play';
  titleOv.classList.add('hidden'); overOv.classList.add('hidden');
}
function gameOver(){
  state = 'over';
  snd.over();
  const f = floorsOf(maxY);
  const isNew = f > best.floors;
  if (isNew) { best = { floors: f, y: maxY }; saveBest(); }
  save.coins += f; saveSave();
  document.getElementById('earnNum').textContent = f;
  document.getElementById('resNum').textContent = f;
  document.getElementById('resBest').textContent = 'さいこう ' + best.floors + 'かい';
  document.getElementById('newrec').hidden = !isNew;
  updateHud();
  setTimeout(() => { overOv.classList.remove('hidden'); document.getElementById('againBtn').focus({ preventScroll: true }); }, 450);
}
document.getElementById('startBtn').addEventListener('click', start);
document.getElementById('againBtn').addEventListener('click', start);

// ---- gacha ----
const COST = 10;
const RATE = [['SSR', 0.03], ['SR', 0.12], ['R', 0.30], ['N', 0.55]];
const RCOL = { N: '#8e9aa3', R: '#3f9ad6', SR: '#b05be0', SSR: '#e0a800' };
const gachaOv = document.getElementById('gachaOv');
const gStage = document.getElementById('gStage');
const gc = gStage.getContext('2d');
const gMsg = document.getElementById('gMsg');
const pullBtn = document.getElementById('pullBtn');
const gCoins = document.getElementById('gCoins');
const grid = document.getElementById('grid');
const SW = 260, SH = 160;
gStage.width = SW * 2; gStage.height = SH * 2; gc.scale(2, 2);
let prevOv = null, gRaf = 0, gAnim = { phase: 'idle', t0: 0, skin: null, isNew: false };

function openGacha(from){
  ensureAudio();
  prevOv = from; from.classList.add('hidden'); gachaOv.classList.remove('hidden');
  gAnim = { phase: 'idle', t0: 0, skin: null, isNew: false };
  gMsg.textContent = '1かい ' + COST + 'コイン'; gMsg.style.color = '';
  updateG(); renderGrid();
  if (!gRaf) gRaf = requestAnimationFrame(gLoop);
}
function closeGacha(){
  gachaOv.classList.add('hidden');
  if (prevOv) prevOv.classList.remove('hidden');
  updateHud();
}
function updateG(){ gCoins.textContent = save.coins; pullBtn.disabled = gAnim.phase === 'shake'; }
function pull(){
  ensureAudio();
  if (gAnim.phase === 'shake') return;
  if (save.coins < COST) {
    gMsg.textContent = 'コインがたりない。あそんでためよう'; gMsg.style.color = '';
    tone(220, 0.1, 'square', 0.06);
    return;
  }
  save.coins -= COST;
  let x = Math.random(), rr = 'N';
  for (const [k, p] of RATE) { if (x < p) { rr = k; break; } x -= p; }
  const pool = SKINS.filter(s => s.r === rr);
  const sk = pool[Math.floor(Math.random() * pool.length)];
  const isNew = !save.owned.includes(sk.id);
  if (isNew) { save.owned.push(sk.id); save.equip = sk.id; } else save.coins += 3;
  saveSave();
  gAnim = { phase: 'shake', t0: performance.now() / 1000, skin: sk, isNew };
  gMsg.textContent = '……'; gMsg.style.color = '';
  tone(420, 0.8, 'triangle', 0.07, 900);
  updateG();
}
function reveal(){
  const sk = gAnim.skin;
  gMsg.textContent = sk.r + ' ' + sk.name + (gAnim.isNew ? ' NEW！' : '（かぶり +3コイン）');
  gMsg.style.color = RCOL[sk.r];
  const notes = { N: [880], R: [880, 1320], SR: [880, 1110, 1480], SSR: [880, 1110, 1320, 1760] }[sk.r];
  notes.forEach((n, i) => setTimeout(() => tone(n, 0.18, 'triangle', 0.15), i * 90));
  renderGrid(); updateG();
}
const easeBack = s => 1 + 2.70158 * Math.pow(s - 1, 3) + 1.70158 * Math.pow(s - 1, 2);
function drawCapsule(x, y, ang, split, alpha){
  gc.save(); gc.globalAlpha = alpha; gc.translate(x, y); gc.rotate(ang);
  gc.fillStyle = '#ff7a1a';
  gc.beginPath(); gc.arc(0, -split, 38, Math.PI, 0); gc.closePath(); gc.fill();
  gc.fillStyle = 'rgba(255,255,255,.35)';
  gc.beginPath(); gc.ellipse(-14, -split - 22, 11, 6, -0.5, 0, TAU); gc.fill();
  gc.fillStyle = '#fbf8f1';
  gc.beginPath(); gc.arc(0, split, 38, 0, Math.PI); gc.closePath(); gc.fill();
  gc.strokeStyle = 'rgba(60,40,20,.25)'; gc.lineWidth = 2;
  gc.beginPath(); gc.arc(0, -split, 38, Math.PI, 0); gc.closePath(); gc.stroke();
  gc.beginPath(); gc.arc(0, split, 38, 0, Math.PI); gc.closePath(); gc.stroke();
  if (split === 0) {
    gc.fillStyle = '#ffffff'; gc.textAlign = 'center'; gc.textBaseline = 'middle';
    gc.font = '24px "Dela Gothic One","Hiragino Sans",sans-serif';
    gc.fillText('?', 0, -16);
  }
  gc.restore();
}
function gLoop(now){
  if (gachaOv.classList.contains('hidden')) { gRaf = 0; return; }
  const T = now / 1000;
  const cx = SW / 2, cy = SH / 2 + 2;
  gc.clearRect(0, 0, SW, SH);
  if (gAnim.phase === 'shake' && T - gAnim.t0 > 0.9) { gAnim.phase = 'open'; gAnim.t0 = T; reveal(); }
  if (gAnim.phase === 'open') {
    const e = T - gAnim.t0, sk = gAnim.skin;
    gc.save(); gc.translate(cx, cy); gc.rotate(e * 0.8);
    gc.globalAlpha = 0.25; gc.fillStyle = RCOL[sk.r];
    for (let i = 0; i < 12; i++) { gc.beginPath(); gc.moveTo(0, 0); gc.arc(0, 0, 220, i * Math.PI / 6, i * Math.PI / 6 + Math.PI / 12); gc.fill(); }
    gc.restore();
    const op = Math.min(1, e / 0.25);
    if (op < 1) drawCapsule(cx, cy, 0, op * 70, 1 - op);
    const s = Math.min(1, e / 0.35);
    gc.save(); gc.translate(cx, cy); sk.draw(gc, 36 * easeBack(s)); gc.restore();
  } else {
    const shakeA = gAnim.phase === 'shake' ? Math.sin((T - gAnim.t0) * 38) * 0.22 : 0;
    const bob = gAnim.phase === 'idle' ? Math.sin(T * 2.2) * 4 : 0;
    drawCapsule(cx, cy + bob, shakeA, 0, 1);
  }
  gRaf = requestAnimationFrame(gLoop);
}
function renderGrid(){
  grid.innerHTML = '';
  let n = 0;
  for (const sk of SKINS) {
    const owned = save.owned.includes(sk.id);
    if (owned) n++;
    const b = document.createElement('button');
    b.className = 'cell' + (save.equip === sk.id ? ' on' : '');
    const cvs = document.createElement('canvas'); cvs.width = 96; cvs.height = 96;
    const c = cvs.getContext('2d'); c.scale(2, 2); c.translate(24, 26);
    if (owned) sk.draw(c, 16);
    else {
      c.fillStyle = 'rgba(127,127,127,.35)'; c.beginPath(); c.arc(0, 0, 16, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,255,.9)'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '16px "Dela Gothic One",sans-serif'; c.fillText('?', 0, 1);
    }
    const nm = document.createElement('span'); nm.textContent = owned ? sk.name : '？？？';
    const rr = document.createElement('span'); rr.className = 'rr'; rr.textContent = sk.r; rr.style.color = RCOL[sk.r];
    b.append(cvs, nm, rr);
    if (owned) b.addEventListener('click', () => { save.equip = sk.id; saveSave(); renderGrid(); });
    else b.disabled = true;
    grid.appendChild(b);
  }
  document.getElementById('gCount').textContent = 'あつめた玉 ' + n + ' / ' + SKINS.length + '（タップでつかう）';
}
pullBtn.addEventListener('click', pull);
document.getElementById('backBtn').addEventListener('click', closeGacha);
document.getElementById('gachaBtn1').addEventListener('click', () => openGacha(titleOv));
document.getElementById('gachaBtn2').addEventListener('click', () => openGacha(overOv));

reset();
let last = performance.now(), acc = 0;
const DT = 1 / 120;
function frame(now){
  let dt = (now - last) / 1000; last = now;
  // コマの間隔は上も下も止める (1 コマ目などで負になることがある。CLAUDE.md の落とし穴)
  if (dt > 0.05) dt = 0.05;
  if (!(dt > 0)) dt = 0;
  if (state !== 'over') { acc += dt; while (acc >= DT) { step(DT); acc -= DT; } }
  else { acc = 0; for (const d of debris) { d.vy -= G * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt; } }
  render();
  requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => { last = performance.now(); });
requestAnimationFrame(frame);
// テストからのぞく入口 (CLAUDE.md「window.__app はテストから中身をのぞくための入口」)
window.__app = {
  get state() { return state; }, get ball() { return ball; }, get spears() { return spears; }, get flying() { return flying; },
  get maxY() { return maxY; }, get bounces() { return bounces; }, get camY() { return camY; }, get size() { return { W, H }; }, get best() { return best; }, get save() { return save; },
  floors: () => floorsOf(maxY), LAUNCH_FRAC, FLY, G, R
};
})();

// オフラインでも開けるように (ネット優先。sw.js)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
