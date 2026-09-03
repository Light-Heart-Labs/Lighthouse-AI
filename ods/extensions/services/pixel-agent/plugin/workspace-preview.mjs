// Publish one static site from Pixel's workspace through the dedicated,
// loopback-only ODS preview service. The host service independently validates
// and snapshots every byte before returning a browser-verifiable URL.

import net from "node:net";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH = "/run/ods-pixel-preview/control.sock";
const PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SITE_ID = /^site-[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 8192;
const SCAFFOLD_THEMES = new Set(["aurora", "ember", "ocean", "orchid", "solar"]);
const SCAFFOLD_TEMPLATES = new Set(["breakout"]);
const BOUNDARY =
  "Create-only static-site snapshot from the configured Pixel workspace to a dedicated loopback preview origin; no arbitrary host path, network destination, server process, overwrite, or execution authority.";

function validRelativeDirectory(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return (
    parts.length <= 12 &&
    parts.every(
      (part) => !["", ".", ".."].includes(part) && PATH_COMPONENT.test(part)
    )
  );
}

function normalizedScaffold(value, relativeDirectory) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["tagline\ntheme\ntitle", "tagline\ntemplate\ntheme\ntitle"].includes(
      Object.keys(value).sort().join("\n")
    ) ||
    relativeDirectory.includes("/") ||
    relativeDirectory.length > 118
  ) {
    throw new Error("invalid Pixel workspace preview request");
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const tagline = typeof value.tagline === "string" ? value.tagline.trim() : "";
  if (
    !title ||
    title.length > 80 ||
    !tagline ||
    tagline.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(`${title}${tagline}`) ||
    !SCAFFOLD_THEMES.has(value.theme) ||
    (value.template !== undefined && !SCAFFOLD_TEMPLATES.has(value.template))
  ) {
    throw new Error("invalid Pixel workspace preview request");
  }
  return {
    title,
    tagline,
    theme: value.theme,
    ...(value.template ? { template: value.template } : {}),
  };
}

export function normalizeWorkspacePreviewParams(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["relativeDirectory", "relativeDirectory\nscaffold"].includes(
      Object.keys(value).sort().join("\n")
    ) ||
    !Object.hasOwn(value, "relativeDirectory") ||
    !validRelativeDirectory(value.relativeDirectory)
  ) {
    throw new Error("invalid Pixel workspace preview request");
  }
  const scaffold = normalizedScaffold(value.scaffold, value.relativeDirectory);
  return {
    schemaVersion: 1,
    action: "publish",
    relativeDirectory: value.relativeDirectory,
    ...(scaffold ? { scaffold } : {}),
  };
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]
  );
}

function showcaseScaffoldHtml({ title, tagline, theme }) {
  const safeTitle = escapeHtml(title);
  const safeTagline = escapeHtml(tagline);
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${safeTitle}</title>
<style>
:root{--hue:272;--a:hsl(var(--hue) 100% 67%);--b:hsl(calc(var(--hue) + 68) 95% 61%);--ink:#f7f5ff;--muted:#aaa5bc;--panel:#14121dcc}*{box-sizing:border-box}html{background:#07060b;color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}body{margin:0;min-height:100vh;overflow-x:hidden;background:radial-gradient(circle at 20% 10%,hsl(var(--hue) 80% 18% / .45),transparent 38%),radial-gradient(circle at 90% 70%,hsl(calc(var(--hue) + 70) 85% 18% / .35),transparent 38%),#07060b}html[data-theme=ember]{--hue:18}html[data-theme=ocean]{--hue:194}html[data-theme=orchid]{--hue:304}html[data-theme=solar]{--hue:48}canvas{position:fixed;inset:0;width:100%;height:100%;opacity:.55;pointer-events:none}.shell{position:relative;z-index:1;max-width:1120px;margin:auto;padding:24px}.nav{display:flex;justify-content:space-between;align-items:center;padding:12px 0}.brand{font-weight:800;letter-spacing:.16em;text-transform:uppercase}.signal{display:flex;gap:8px;align-items:center;color:#8dffbb;font-size:.8rem}.dot{width:8px;height:8px;border-radius:50%;background:#4cff91;box-shadow:0 0 18px #4cff91}.hero{padding:12vh 0 8vh;max-width:850px}.eyebrow{color:var(--a);letter-spacing:.18em;text-transform:uppercase;font-size:.75rem}.hero h1{font-size:clamp(3rem,9vw,7rem);line-height:.88;letter-spacing:-.065em;margin:.2em 0;background:linear-gradient(120deg,#fff 20%,var(--a),var(--b));-webkit-background-clip:text;color:transparent}.hero p{max-width:680px;font-size:clamp(1rem,2vw,1.35rem);color:var(--muted)}button{border:1px solid #ffffff26;color:var(--ink);background:#ffffff0a;border-radius:999px;padding:12px 18px;cursor:pointer;transition:.2s transform,.2s border-color,.2s background}button:hover,button:focus-visible{transform:translateY(-2px);border-color:var(--a);background:#ffffff12;outline:none}.primary{background:linear-gradient(120deg,var(--a),var(--b));color:#08060c;font-weight:800;border:0;box-shadow:0 12px 50px hsl(var(--hue) 100% 55% / .25)}.actions,.themes{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}.themes button{width:34px;height:34px;padding:0;background:hsl(var(--c) 90% 60%);border:2px solid #fff5}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{position:relative;overflow:hidden;min-height:190px;padding:24px;border:1px solid #ffffff18;border-radius:24px;background:linear-gradient(145deg,#ffffff0d,#ffffff04);backdrop-filter:blur(16px);transition:.25s transform,.25s border-color}.card:hover,.card.active{transform:translateY(-7px);border-color:var(--a)}.card b{display:block;font-size:2.2rem}.card span{color:var(--muted)}.meter{height:6px;background:#ffffff12;border-radius:9px;margin-top:24px;overflow:hidden}.meter i{display:block;height:100%;width:18%;background:linear-gradient(90deg,var(--a),var(--b));transition:1s width}.console{display:flex;justify-content:space-between;gap:20px;margin:16px 0 60px;padding:18px 22px;border:1px solid #ffffff14;border-radius:18px;background:var(--panel);color:var(--muted)}#status{color:var(--a)}@media(max-width:720px){.grid{grid-template-columns:1fr}.hero{padding-top:8vh}.console{flex-direction:column}}
</style></head>
<body><canvas id="sky"></canvas><main class="shell"><nav class="nav"><div class="brand">${safeTitle}</div><div class="signal"><i class="dot"></i>LIVE SYSTEM</div></nav><section class="hero"><div class="eyebrow">Interactive field experiment</div><h1>${safeTitle}</h1><p>${safeTagline}</p><div class="actions"><button class="primary" id="launch">Launch sequence</button><button id="shuffle">Shift the spectrum</button></div><div class="themes" aria-label="Color themes"><button data-t="aurora" style="--c:272" aria-label="Aurora"></button><button data-t="ember" style="--c:18" aria-label="Ember"></button><button data-t="ocean" style="--c:194" aria-label="Ocean"></button><button data-t="orchid" style="--c:304" aria-label="Orchid"></button><button data-t="solar" style="--c:48" aria-label="Solar"></button></div></section><section class="grid"><article class="card"><b>01</b><h2>Responsive</h2><span>Fluid type, adaptive layout, and touch-friendly controls.</span><div class="meter"><i></i></div></article><article class="card"><b>02</b><h2>Alive</h2><span>A living canvas reacts while the interface changes around it.</span><div class="meter"><i></i></div></article><article class="card"><b>03</b><h2>Local</h2><span>Self-contained HTML, CSS, and JavaScript. No external calls.</span><div class="meter"><i></i></div></article></section><div class="console"><span>PIXEL / VERIFIED PREVIEW</span><span id="status">Ready for interaction</span></div></main>
<script>
const root=document.documentElement,status=document.querySelector('#status'),bars=[...document.querySelectorAll('.meter i')];document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{root.dataset.theme=b.dataset.t;status.textContent=b.dataset.t.toUpperCase()+' spectrum online'});document.querySelector('#shuffle').onclick=()=>{root.style.setProperty('--hue',Math.floor(Math.random()*360));status.textContent='Spectrum randomized'};document.querySelector('#launch').onclick=e=>{e.currentTarget.textContent='Sequence launched ✓';status.textContent='All interactive systems nominal';bars.forEach((b,i)=>setTimeout(()=>b.style.width=(72+i*12)+'%',i*180))};document.querySelectorAll('.card').forEach(c=>c.onclick=()=>c.classList.toggle('active'));
const c=document.querySelector('#sky'),x=c.getContext('2d'),pts=Array.from({length:70},()=>({x:Math.random(),y:Math.random(),r:Math.random()*1.7+.3,v:Math.random()*.0005+.0001}));function frame(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;x.fillStyle='#fff';pts.forEach(p=>{p.y-=p.v;if(p.y<0)p.y=1;x.globalAlpha=.25+p.r/3;x.beginPath();x.arc(p.x*c.width,p.y*c.height,p.r*devicePixelRatio,0,7);x.fill()});requestAnimationFrame(frame)}frame();
</script></body></html>`;
}

function breakoutScaffoldHtml({ title, tagline, theme }) {
  const safeTitle = escapeHtml(title);
  const safeTagline = escapeHtml(tagline);
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${safeTitle}</title>
<style>
:root{color-scheme:dark;--pink:#ff3fd2;--violet:#9b5cff;--cyan:#38dcff;--lime:#8dffb7;--ink:#f9f6ff;--muted:#aaa2bd;--panel:#171123cc}*{box-sizing:border-box}html{min-height:100%;background:#07050d;font:16px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 12%,#7b24b53d,transparent 34%),radial-gradient(circle at 88% 78%,#164f9e42,transparent 35%),linear-gradient(145deg,#07050d,#0c0715 58%,#050910);overflow-x:hidden}.noise{position:fixed;inset:0;pointer-events:none;opacity:.32;background-image:linear-gradient(#ffffff05 1px,transparent 1px),linear-gradient(90deg,#ffffff05 1px,transparent 1px);background-size:36px 36px;mask-image:linear-gradient(to bottom,#000,transparent 90%)}.shell{position:relative;z-index:1;width:min(1180px,100%);margin:auto;padding:clamp(18px,4vw,44px)}header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.kicker{margin:0 0 5px;color:var(--cyan);font-size:.72rem;font-weight:800;letter-spacing:.22em;text-transform:uppercase}h1{margin:0;font-size:clamp(2.3rem,6vw,5.4rem);line-height:.88;letter-spacing:-.055em;background:linear-gradient(110deg,#fff 15%,#fbc8ff 48%,var(--pink) 76%,var(--cyan));background-clip:text;-webkit-background-clip:text;color:transparent}.tagline{max-width:430px;margin:0;color:var(--muted);text-align:right}.game-card{border:1px solid #ffffff20;border-radius:28px;background:linear-gradient(145deg,#ffffff0e,#ffffff04);box-shadow:0 28px 90px #0008,0 0 80px #ad35ff12;backdrop-filter:blur(20px);overflow:hidden}.hud{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid #ffffff16}.stat{padding:14px 20px}.stat+ .stat{border-left:1px solid #ffffff16}.label{display:block;color:var(--muted);font-size:.68rem;letter-spacing:.15em;text-transform:uppercase}.value{display:block;margin-top:2px;font:800 clamp(1.1rem,3vw,1.55rem)/1 ui-monospace,SFMono-Regular,monospace}.arena{position:relative;padding:clamp(10px,2vw,22px);background:linear-gradient(180deg,#090510,#04030a)}canvas{display:block;width:100%;height:auto;aspect-ratio:3/2;border:1px solid #ffffff17;border-radius:18px;background:#05030b;box-shadow:inset 0 0 70px #0009;touch-action:none}.overlay{position:absolute;inset:clamp(10px,2vw,22px);display:grid;place-items:center;border-radius:18px;background:radial-gradient(circle,#180c2ccc,#05030be8);transition:.25s opacity;z-index:2}.overlay.hidden{opacity:0;pointer-events:none}.overlay-card{text-align:center;padding:24px}.overlay-card strong{display:block;font-size:clamp(1.6rem,4vw,3.2rem);letter-spacing:-.04em}.overlay-card span{display:block;margin:8px auto 22px;max-width:420px;color:var(--muted)}button{border:1px solid #ffffff26;border-radius:999px;background:#ffffff0b;color:var(--ink);padding:11px 18px;font:700 .9rem/1 inherit;cursor:pointer;transition:.18s transform,.18s border-color,.18s background;touch-action:manipulation}button:hover,button:focus-visible{transform:translateY(-2px);border-color:var(--cyan);background:#ffffff13;outline:none}button.primary{border:0;background:linear-gradient(110deg,var(--pink),var(--violet),var(--cyan));color:#09030e;box-shadow:0 12px 34px #d936ff42}.footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-top:1px solid #ffffff16}.status{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:.84rem}.pulse{width:8px;height:8px;border-radius:50%;background:var(--lime);box-shadow:0 0 18px var(--lime)}.actions,.touch{display:flex;gap:9px}.touch{display:none}.help{margin:16px 4px 0;color:#898198;font-size:.78rem;text-align:center}@media(max-width:720px){header{align-items:flex-start;flex-direction:column}.tagline{text-align:left}.footer{align-items:stretch;flex-direction:column}.footer .actions{justify-content:space-between}.touch{display:flex;justify-content:center;margin-top:12px}.touch button{min-width:74px;min-height:46px}.help{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head>
<body><div class="noise"></div><main class="shell"><header><div><p class="kicker">Pixel / local arcade</p><h1>${safeTitle}</h1></div><p class="tagline">${safeTagline}</p></header><section class="game-card" aria-label="Breakout game"><div class="hud"><div class="stat"><span class="label">Score</span><span class="value" id="score">000000</span></div><div class="stat"><span class="label">Lives</span><span class="value" id="lives">● ● ●</span></div><div class="stat"><span class="label">Level</span><span class="value" id="level">01</span></div></div><div class="arena"><canvas id="game" width="900" height="600" tabindex="0" aria-label="Neon Breakout play field"></canvas><div class="overlay" id="overlay"><div class="overlay-card"><strong id="overlay-title">Signal locked</strong><span id="overlay-copy">Clear every neon brick. Move with the pointer, touch, arrow keys, or A and D.</span><button class="primary" id="launch">Launch game</button></div></div><div class="touch" aria-label="Touch controls"><button id="left" aria-label="Move paddle left">&larr;</button><button id="touch-launch" class="primary">Launch</button><button id="right" aria-label="Move paddle right">&rarr;</button></div></div><div class="footer"><div class="status" aria-live="polite"><i class="pulse"></i><span id="status">Ready for input</span></div><div class="actions"><button id="pause">Pause</button><button id="reset">New run</button></div></div></section><p class="help">Move: ← → or A D · Launch: Space · Pause: P · Restart: R</p></main>
<script>
const canvas=document.querySelector('#game'),ctx=canvas.getContext('2d'),W=900,H=600;
const scoreEl=document.querySelector('#score'),livesEl=document.querySelector('#lives'),levelEl=document.querySelector('#level'),statusEl=document.querySelector('#status'),overlay=document.querySelector('#overlay'),overlayTitle=document.querySelector('#overlay-title'),overlayCopy=document.querySelector('#overlay-copy'),launchButton=document.querySelector('#launch');
let score=0,lives=3,level=1,mode='ready',last=0,bricks=[],particles=[];
const keys={left:false,right:false};
const paddle={x:375,y:550,w:150,h:15,speed:560};
const ball={x:450,y:526,r:9,vx:250,vy:-300};
const colors=['#ff3fd2','#b45cff','#5c7cff','#38dcff','#72ffce'];
function rounded(x,y,w,h,r){ctx.beginPath();if(typeof ctx.roundRect==='function')ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h)}
function buildBricks(){bricks=[];const cols=9,rows=Math.min(5+level,8),gap=8,bw=80,bh=22,start=(W-(cols*bw+(cols-1)*gap))/2;for(let row=0;row<rows;row++)for(let col=0;col<cols;col++)bricks.push({x:start+col*(bw+gap),y:72+row*(bh+gap),w:bw,h:bh,alive:true,color:colors[row%colors.length]})}
function syncHud(){scoreEl.textContent=String(score).padStart(6,'0');livesEl.textContent=Array.from({length:Math.max(0,lives)},()=> '●').join(' ')||'—';levelEl.textContent=String(level).padStart(2,'0')}
function setStatus(text){statusEl.textContent=text}
function setOverlay(title,copy,button){overlayTitle.textContent=title;overlayCopy.textContent=copy;launchButton.textContent=button;overlay.inert=false;overlay.removeAttribute('aria-hidden');overlay.classList.remove('hidden')}
function hideOverlay(){overlay.inert=true;overlay.setAttribute('aria-hidden','true');overlay.classList.add('hidden');canvas.focus()}
function resetBall(){paddle.x=(W-paddle.w)/2;ball.x=W/2;ball.y=paddle.y-ball.r-4;const direction=Math.random()>.5?1:-1;ball.vx=direction*(230+level*16);ball.vy=-(300+level*18)}
function newRun(){score=0;lives=3;level=1;mode='ready';particles=[];buildBricks();resetBall();syncHud();setStatus('Ready for input');setOverlay('Signal locked','Clear every neon brick. Move with the pointer, touch, arrow keys, or A and D.','Launch game')}
function launch(){if(mode==='gameover'){newRun();return}if(mode==='paused'){mode='playing';hideOverlay();setStatus('Run resumed');return}if(mode==='ready'){mode='playing';hideOverlay();setStatus('Signal in motion')}}
function togglePause(){if(mode==='playing'){mode='paused';setStatus('Run paused');setOverlay('Paused','Your run is safely suspended.','Resume')}else if(mode==='paused')launch()}
function burst(x,y,color){for(let i=0;i<13;i++)particles.push({x,y,vx:(Math.random()-.5)*260,vy:(Math.random()-.7)*260,life:1,color})}
function loseBall(){lives-=1;syncHud();if(lives<=0){mode='gameover';setStatus('Run complete');setOverlay('Signal lost','Final score '+score+'. The wall is ready for another run.','Play again')}else{mode='ready';resetBall();setStatus('Life lost — launch when ready');setOverlay('Recalibrate',lives+' lives remain.','Launch ball')}}
function nextLevel(){score+=500;level+=1;mode='ready';buildBricks();resetBall();syncHud();setStatus('Level cleared');setOverlay('Wall breached','Level '+level+' is denser and faster.','Launch next level')}
function update(dt){if(keys.left)paddle.x-=paddle.speed*dt;if(keys.right)paddle.x+=paddle.speed*dt;paddle.x=Math.max(18,Math.min(W-paddle.w-18,paddle.x));if(mode==='ready'){ball.x=paddle.x+paddle.w/2;ball.y=paddle.y-ball.r-4}if(mode==='playing'){ball.x+=ball.vx*dt;ball.y+=ball.vy*dt;if(ball.x-ball.r<12){ball.x=12+ball.r;ball.vx=Math.abs(ball.vx)}if(ball.x+ball.r>W-12){ball.x=W-12-ball.r;ball.vx=-Math.abs(ball.vx)}if(ball.y-ball.r<12){ball.y=12+ball.r;ball.vy=Math.abs(ball.vy)}if(ball.vy>0&&ball.y+ball.r>=paddle.y&&ball.y-ball.r<=paddle.y+paddle.h&&ball.x>=paddle.x-ball.r&&ball.x<=paddle.x+paddle.w+ball.r){ball.y=paddle.y-ball.r;const hit=(ball.x-(paddle.x+paddle.w/2))/(paddle.w/2);const speed=Math.min(560,Math.hypot(ball.vx,ball.vy)+9);ball.vx=speed*hit*.9;ball.vy=-Math.sqrt(Math.max(130*130,speed*speed-ball.vx*ball.vx))}for(const brick of bricks){if(!brick.alive)continue;if(ball.x+ball.r>brick.x&&ball.x-ball.r<brick.x+brick.w&&ball.y+ball.r>brick.y&&ball.y-ball.r<brick.y+brick.h){brick.alive=false;ball.vy*=-1;score+=100;syncHud();burst(ball.x,ball.y,brick.color);break}}if(!bricks.some(brick=>brick.alive))nextLevel();else if(ball.y-ball.r>H)loseBall()}for(const p of particles){p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=260*dt;p.life-=1.7*dt}particles=particles.filter(p=>p.life>0)}
function draw(){ctx.clearRect(0,0,W,H);const glow=ctx.createRadialGradient(W/2,H/2,20,W/2,H/2,560);glow.addColorStop(0,'#190d2c');glow.addColorStop(1,'#040309');ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);ctx.strokeStyle='#ffffff0b';ctx.lineWidth=1;for(let x=20;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke()}for(let y=20;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}for(const brick of bricks){if(!brick.alive)continue;ctx.save();ctx.shadowColor=brick.color;ctx.shadowBlur=15;ctx.fillStyle=brick.color;rounded(brick.x,brick.y,brick.w,brick.h,7);ctx.fill();ctx.fillStyle='#ffffff44';rounded(brick.x+4,brick.y+3,brick.w-8,4,3);ctx.fill();ctx.restore()}ctx.save();ctx.shadowColor='#38dcff';ctx.shadowBlur=22;const paddleGradient=ctx.createLinearGradient(paddle.x,paddle.y,paddle.x+paddle.w,paddle.y);paddleGradient.addColorStop(0,'#ff3fd2');paddleGradient.addColorStop(.5,'#f8f3ff');paddleGradient.addColorStop(1,'#38dcff');ctx.fillStyle=paddleGradient;rounded(paddle.x,paddle.y,paddle.w,paddle.h,9);ctx.fill();ctx.restore();ctx.save();ctx.shadowColor='#fff';ctx.shadowBlur=26;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(ball.x,ball.y,ball.r,0,Math.PI*2);ctx.fill();ctx.restore();for(const p of particles){ctx.globalAlpha=Math.max(0,p.life);ctx.fillStyle=p.color;ctx.fillRect(p.x,p.y,4,4)}ctx.globalAlpha=1}
function frame(time){const dt=Math.min(.024,(time-last)/1000||0);last=time;update(dt);draw();requestAnimationFrame(frame)}
function pointerMove(event){const rect=canvas.getBoundingClientRect();const clientX=event.touches?event.touches[0].clientX:event.clientX;paddle.x=(clientX-rect.left)*(W/rect.width)-paddle.w/2}
function bindHold(id,key){const element=document.querySelector(id);const on=event=>{event.preventDefault();keys[key]=true};const off=event=>{event.preventDefault();keys[key]=false};element.addEventListener('pointerdown',on);element.addEventListener('pointerup',off);element.addEventListener('pointercancel',off);element.addEventListener('pointerleave',off)}
addEventListener('keydown',event=>{if(['ArrowLeft','a','A'].includes(event.key))keys.left=true;if(['ArrowRight','d','D'].includes(event.key))keys.right=true;if(event.code==='Space'){event.preventDefault();launch()}if(event.key==='p'||event.key==='P')togglePause();if(event.key==='r'||event.key==='R')newRun()});addEventListener('keyup',event=>{if(['ArrowLeft','a','A'].includes(event.key))keys.left=false;if(['ArrowRight','d','D'].includes(event.key))keys.right=false});canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerdown',event=>{pointerMove(event);launch()});launchButton.onclick=launch;document.querySelector('#touch-launch').onclick=launch;document.querySelector('#pause').onclick=togglePause;document.querySelector('#reset').onclick=newRun;bindHold('#left','left');bindHold('#right','right');document.addEventListener('visibilitychange',()=>{if(document.hidden&&mode==='playing')togglePause()});newRun();requestAnimationFrame(frame);
</script></body></html>`;
}

function scaffoldHtml(scaffold) {
  return scaffold.template === "breakout"
    ? breakoutScaffoldHtml(scaffold)
    : showcaseScaffoldHtml(scaffold);
}

export async function createWorkspaceScaffold(
  { workspaceRoot, relativeDirectory, scaffold },
  {
    currentUid = () => process.getuid?.(),
    uniqueSuffix = () => randomBytes(4).toString("hex"),
  } = {}
) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const canonicalRoot = await realpath(resolvedRoot);
  const rootStat = await lstat(canonicalRoot);
  const uid = currentUid();
  if (
    canonicalRoot !== resolvedRoot ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !Number.isInteger(uid) ||
    rootStat.uid !== uid ||
    (rootStat.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe Pixel workspace root");
  }
  const suffix = uniqueSuffix();
  if (typeof suffix !== "string" || !/^[a-f0-9]{8}$/.test(suffix)) {
    throw new Error("invalid Pixel workspace scaffold suffix");
  }
  const allocatedDirectory = `${relativeDirectory}-${suffix}`;
  const directory = path.join(canonicalRoot, allocatedDirectory);
  await mkdir(directory, { mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  const directoryStat = await lstat(canonicalDirectory);
  if (
    canonicalDirectory !== directory ||
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== uid
  ) {
    throw new Error("unsafe Pixel workspace scaffold directory");
  }
  const entry = path.join(canonicalDirectory, "index.html");
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(entry, flags, 0o600);
  try {
    await handle.writeFile(scaffoldHtml(scaffold), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return allocatedDirectory;
}

function validResponse(value, request) {
  const expectedKeys = [
    "boundary",
    "bytes",
    "entryFile",
    "entrySha256",
    "executable",
    "files",
    "httpStatus",
    "kind",
    "overwritten",
    "port",
    "readbackVerified",
    "relativeDirectory",
    "schemaVersion",
    "sha256",
    "siteId",
    "status",
    "url",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== expectedKeys.join("\n") ||
    value.schemaVersion !== 1 ||
    value.kind !== "ods-pixel-workspace-preview" ||
    value.status !== "succeeded" ||
    value.relativeDirectory !== request.relativeDirectory ||
    !SITE_ID.test(value.siteId) ||
    typeof value.url !== "string" ||
    value.url !== `http://localhost:${value.port}/${value.siteId}/` ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !Number.isInteger(value.files) ||
    value.files < 1 ||
    value.files > 128 ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 16 * 1024 * 1024 ||
    !SHA256.test(value.sha256) ||
    !SHA256.test(value.entrySha256) ||
    value.entryFile !== "index.html" ||
    value.httpStatus !== 200 ||
    value.readbackVerified !== true ||
    value.executable !== false ||
    value.overwritten !== false ||
    value.boundary !== BOUNDARY
  ) {
    throw new Error("invalid Pixel workspace preview response");
  }
  return value;
}

function socketRequest(payload, socketPath = SOCKET_PATH) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection({ path: socketPath });
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      callback(value);
    };
    connection.setTimeout(30_000);
    connection.on("connect", () => {
      connection.end(`${JSON.stringify(payload)}\n`);
    });
    connection.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        finish(reject, new Error("Pixel workspace preview response is too large"));
        return;
      }
      chunks.push(chunk);
    });
    connection.on("end", () => {
      try {
        const raw = Buffer.concat(chunks, total).toString("utf8");
        if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) {
          throw new Error("invalid Pixel workspace preview framing");
        }
        finish(resolve, JSON.parse(raw.slice(0, -1)));
      } catch (error) {
        finish(reject, error);
      }
    });
    connection.on("timeout", () =>
      finish(reject, new Error("Pixel workspace preview timed out"))
    );
    connection.on("error", (error) => finish(reject, error));
  });
}

function failedResult() {
  return {
    content: [{
      type: "text",
      text:
        "ODS could not publish a verified browser preview. Keep the site files in the workspace, correct the reported file or entry-point problem if one was returned, and do not claim a localhost URL is live.",
    }],
    details: {
      schemaVersion: 1,
      kind: "ods-pixel-workspace-preview",
      status: "failed",
      boundary: BOUNDARY,
    },
    isError: true,
  };
}

export function createWorkspacePreviewTool({
  request = socketRequest,
  scaffold = createWorkspaceScaffold,
  workspaceRoot = path.join(os.homedir(), ".openclaw", "workspace-pixel"),
} = {}) {
  return {
    name: "pixel_ods_workspace_preview",
    description:
      "Publish and verify a static visual artifact in Pixel's writable workspace. For an open-ended demo, include scaffold with a short title, tagline, and one theme (aurora, ember, ocean, orchid, or solar); use the optional breakout template only for an explicitly requested Breakout-style game. ODS will create a polished interactive create-only index.html before publishing it. For a custom site, app, SVG, game, or visualization already written with workspace tools, pass only relativeDirectory. ODS validates and snapshots the files, then returns the only localhost URL Pixel may claim is browser-accessible. Never start a sandbox server.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["relativeDirectory"],
      properties: {
        relativeDirectory: {
          type: "string",
          description:
            "Static-site directory relative to the Pixel workspace; it must contain index.html.",
        },
        scaffold: {
          type: "object",
          additionalProperties: false,
          required: ["title", "tagline", "theme"],
          properties: {
            title: { type: "string", maxLength: 80 },
            tagline: { type: "string", maxLength: 200 },
            theme: {
              type: "string",
              enum: ["aurora", "ember", "ocean", "orchid", "solar"],
            },
            template: {
              type: "string",
              enum: ["breakout"],
            },
          },
        },
      },
    },
    execute: async (_toolCallId, params) => {
      try {
        const normalized = normalizeWorkspacePreviewParams(params);
        let publishDirectory = normalized.relativeDirectory;
        if (normalized.scaffold) {
          publishDirectory = await scaffold({
            workspaceRoot,
            relativeDirectory: normalized.relativeDirectory,
            scaffold: normalized.scaffold,
          });
          if (
            !validRelativeDirectory(publishDirectory) ||
            publishDirectory.includes("/") ||
            !publishDirectory.startsWith(`${normalized.relativeDirectory}-`) ||
            !/^[a-f0-9]{8}$/.test(
              publishDirectory.slice(normalized.relativeDirectory.length + 1)
            )
          ) {
            throw new Error("invalid allocated Pixel workspace scaffold directory");
          }
        }
        const publishRequest = {
          schemaVersion: normalized.schemaVersion,
          action: normalized.action,
          relativeDirectory: publishDirectory,
        };
        const response = validResponse(await request(publishRequest), publishRequest);
        return {
          content: [{
            type: "text",
            text:
              `ODS ${normalized.scaffold ? "created, " : ""}published, and independently read back ${response.files} static files ` +
              `(${response.bytes} bytes). Verified browser URL: ${response.url}`,
          }],
          details: response,
        };
      } catch {
        return failedResult();
      }
    },
  };
}

export const testing = Object.freeze({
  BOUNDARY,
  validRelativeDirectory,
  validResponse,
});
