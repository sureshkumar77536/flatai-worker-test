// Cloudflare Worker — FlatAI Image Generator Proxy (UNLIMITED VERSION)
// Fix: Uses direct fetch with IP Spoofing (X-Forwarded-For) to bypass daily limits reliably without breaking Cookies.

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, version: '2.0-unlimited-fixed' });
    }

    if (request.method === 'POST' && url.pathname === '/api/generate') {
      return handleGenerate(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// Random user agents for device rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Generate random IP to bypass basic WAF/IP Limits
function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

// Custom fetch that adds spoofed IP headers
async function fetchWithBypass(url, options, sessionIP, timeout = 25000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  const headers = new Headers(options.headers || {});
  if (sessionIP) {
    headers.set('X-Forwarded-For', sessionIP);
    headers.set('X-Real-IP', sessionIP);
    headers.set('Client-IP', sessionIP);
  }

  try {
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function getFreshSession(retry = 0) {
  try {
    const ua = getRandomUA();
    const sessionIP = getRandomIP(); // Bind a unique IP to this session
    
    const resp = await fetchWithBypass('https://flatai.org/ai-image-generator-free-no-signup/', {
      headers: {
        'user-agent': ua,
        'accept': 'text/html,application/xhtml+xml',
      },
    }, sessionIP, 15000);

    const html = await resp.text();
    const nonceMatch = html.match(/"ai_generate_image_nonce":"([^"]+)"/);
    const nonce = nonceMatch ? nonceMatch[1] : null;

    const cookies = [];
    const setCookies = resp.headers.getSetCookie?.() || [];
    if (setCookies.length === 0) {
      const sc = resp.headers.get('set-cookie');
      if (sc) setCookies.push(sc);
    }
    setCookies.forEach(c => cookies.push(c.split(';')[0]));

    if (!nonce && retry < 2) {
      await sleep(1000);
      return getFreshSession(retry + 1);
    }

    return { nonce, cookies: cookies.join('; '), ua, ip: sessionIP };
  } catch (e) {
    if (retry < 2) {
      await sleep(1000);
      return getFreshSession(retry + 1);
    }
    throw e;
  }
}

async function generateOneImage(params, session) {
  const { prompt, aspect_ratio, seed, style_model, enable_upscale } = params;
  
  const body = new URLSearchParams({
    action: 'ai_generate_image',
    nonce: session.nonce,
    prompt,
    aspect_ratio: aspect_ratio || '1:1',
    seed: String(seed),
    style_model: style_model || 'flataipro',
    enable_upscale: enable_upscale !== false ? 'true' : 'false',
  });

  const resp = await fetchWithBypass('https://flatai.org/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': session.ua,
      'origin': 'https://flatai.org',
      'referer': 'https://flatai.org/ai-image-generator-free-no-signup/',
      'x-requested-with': 'XMLHttpRequest',
      ...(session.cookies ? { cookie: session.cookies } : {}),
    },
    body: body.toString(),
  }, session.ip, 30000);

  const data = await resp.json();
  
  if (!data.success) {
    throw new Error(data.data?.message || 'Generation failed');
  }

  if (data.data?.images?.length > 0 && !data.data.pending) {
    return data.data;
  }

  const token = data.data?.job_token;
  if (!token) throw new Error('No job token');

  return await pollForResult(token, session, seed);
}

async function pollForResult(token, session, seed) {
  const start = Date.now();
  const maxWait = 55000;
  
  while (Date.now() - start < maxWait) {
    await sleep(3000);
    
    // Refresh nonce using the SAME IP and UA
    let currentSession = session;
    try {
      currentSession = await getFreshSession();
      currentSession.ip = session.ip; // Keep IP consistent during polling
    } catch {
      // Continue with old session if refresh fails
    }

    const body = new URLSearchParams({
      action: 'ai_poll_generation_status',
      nonce: currentSession.nonce,
      job_token: token,
    });

    try {
      const resp = await fetchWithBypass('https://flatai.org/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': currentSession.ua,
          'origin': 'https://flatai.org',
          'referer': 'https://flatai.org/ai-image-generator-free-no-signup/',
          'x-requested-with': 'XMLHttpRequest',
          ...(currentSession.cookies ? { cookie: currentSession.cookies } : {}),
        },
        body: body.toString(),
      }, currentSession.ip, 15000);

      const data = await resp.json();
      
      if (!data.success) continue;
      if (data.data?.pending) continue;
      
      return { ...data.data, seed };
    } catch {
      continue;
    }
  }
  
  throw new Error('Generation timed out');
}

async function handleGenerate(request) {
  try {
    const body = await request.json();
    const { prompt, aspect_ratio, seed, style_model, enable_upscale, quantity = 1 } = body;

    if (!prompt) {
      return Response.json({ error: 'Prompt required' }, { status: 400 });
    }

    const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 5);
    const results = [];
    const errors = [];

    for (let i = 0; i < qty; i++) {
      try {
        const session = await getFreshSession();
        if (!session.nonce) {
          errors.push(`Image ${i + 1}: Failed to get secure session`);
          continue;
        }

        const usedSeed = seed ? parseInt(seed) + i : Math.floor(Math.random() * 4294967295);
        
        const result = await generateOneImage({
          prompt,
          aspect_ratio,
          seed: usedSeed,
          style_model,
          enable_upscale,
        }, session);

        results.push({ index: i + 1, ...result, seed: usedSeed });
        
        if (i < qty - 1) await sleep(2000);
        
      } catch (err) {
        errors.push(`Image ${i + 1}: ${err.message}`);
      }
    }

    if (results.length === 0) {
      return Response.json({ error: 'All failed', details: errors }, { status: 500 });
    }

    return Response.json({
      success: true,
      data: {
        images: results.flatMap(r => r.images || []),
        results,
        errors: errors.length > 0 ? errors : undefined,
        quantity: qty,
        generated: results.length,
      }
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== HTML UI (unchanged) =====
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Asia AI Image Generator — FlatAI (Unlimited)</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0b0b14;--surface:#131320;--card:#191930;--border:#2e2e50;--accent:#e94560;--accent-glow:rgba(233,69,96,.3);--gold:#f5c518;--text:#ececf5;--dim:#7a7a9e;--ok:#00d26a;--err:#ff4757;--r:14px}
html{scroll-behavior:smooth}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;background-image:radial-gradient(ellipse at 15% 50%,rgba(233,69,96,.05) 0%,transparent 55%),radial-gradient(ellipse at 85% 15%,rgba(99,102,241,.08) 0%,transparent 50%)}
.hero{text-align:center;padding:3.5rem 1.5rem 2rem}
.hero h1{font-size:clamp(1.6rem,5vw,2.8rem);font-weight:800;background:linear-gradient(135deg,#fff 15%,var(--accent) 55%,var(--gold) 90%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;line-height:1.2;margin-bottom:.4rem}
.hero p{color:var(--dim);font-size:.95rem;max-width:480px;margin:0 auto}
.pills{display:flex;gap:.4rem;justify-content:center;margin-top:1rem;flex-wrap:wrap}
.pill{font-size:.68rem;font-weight:600;padding:.25rem .65rem;border-radius:20px;text-transform:uppercase;letter-spacing:.4px}
.pill.green{background:rgba(0,210,106,.1);color:var(--ok);border:1px solid rgba(0,210,106,.2)}
.pill.red{background:rgba(233,69,96,.08);color:var(--accent);border:1px solid rgba(233,69,96,.15)}
.pill.yellow{background:rgba(245,197,24,.08);color:var(--gold);border:1px solid rgba(245,197,24,.15)}
.pill.blue{background:rgba(99,102,241,.1);color:#6366f1;border:1px solid rgba(99,102,241,.2)}
.wrap{max-width:920px;margin:0 auto;padding:0 1.25rem 3rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:1.5rem;margin-bottom:1.25rem;box-shadow:0 6px 28px rgba(0,0,0,.25)}
.label{font-size:.75rem;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;margin-bottom:.65rem}
textarea#prompt{width:100%;background:var(--bg);border:2px solid var(--border);border-radius:10px;padding:.8rem 1rem;font-size:.95rem;color:var(--text);resize:none;min-height:60px;max-height:180px;font-family:inherit;transition:border-color .2s;line-height:1.5}
textarea#prompt::placeholder{color:var(--dim)}
textarea#prompt:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.75rem}
.chip{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:20px;padding:.35rem .7rem;font-size:.72rem;color:var(--dim);cursor:pointer;transition:all .2s;white-space:nowrap}
.chip:hover{background:rgba(233,69,96,.08);border-color:var(--accent);color:var(--text)}
.controls{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:.25rem}
.field label{font-size:.68rem;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
select,.num-input{background:var(--bg);border:2px solid var(--border);border-radius:10px;padding:.55rem .75rem;color:var(--text);font-size:.83rem;min-width:110px;transition:border-color .2s;cursor:pointer}
select:focus,.num-input:focus{outline:none;border-color:var(--accent)}
select option{background:var(--card);color:var(--text)}
.seed-row{display:flex;gap:.4rem;align-items:center}
.seed-btn{background:rgba(233,69,96,.06);border:2px solid var(--border);border-radius:10px;padding:.55rem .75rem;color:var(--dim);font-size:.78rem;cursor:pointer;transition:all .2s;font-weight:700;white-space:nowrap}
.seed-btn.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.seed-btn:hover{border-color:var(--accent)}
.go{width:100%;padding:.85rem;border:none;border-radius:10px;font-size:1.05rem;font-weight:700;cursor:pointer;background:linear-gradient(135deg,var(--accent),#c0392b);color:#fff;transition:all .3s;display:flex;align-items:center;justify-content:center;gap:.5rem;box-shadow:0 4px 18px var(--accent-glow);letter-spacing:.2px;margin-top:1.25rem}
.go:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 28px var(--accent-glow)}
.go:disabled{opacity:.5;cursor:not-allowed}
.go.loading{background:linear-gradient(135deg,#6366f1,#4f46e5)}
.go .spin{display:none;width:20px;height:20px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:sp .8s linear infinite}
.go.loading .spin{display:block}
.go.loading .bt{display:none}
@keyframes sp{to{transform:rotate(360deg)}}
.viewer{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;position:relative;min-height:380px;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 28px rgba(0,0,0,.25)}
.placeholder{text-align:center;color:var(--dim);padding:2rem}
.placeholder .big{font-size:2.8rem;margin-bottom:.6rem;opacity:.35}
#resultImg{width:100%;height:auto;display:none;animation:fi .5s ease}
@keyframes fi{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
.badge-seed{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.75);font-size:.68rem;font-weight:600;padding:.25rem .55rem;border-radius:8px;font-family:monospace;display:none}
.actions{position:absolute;bottom:10px;right:10px;display:none;gap:.4rem}
.abtn{background:rgba(0,0,0,.55);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.12);color:#fff;width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;font-size:.85rem}
.abtn:hover{background:rgba(233,69,96,.65);transform:translateY(-1px)}
.overlay{position:absolute;inset:0;background:rgba(11,11,20,.85);display:none;align-items:center;justify-content:center;flex-direction:column;gap:.8rem;z-index:5;backdrop-filter:blur(4px)}
.overlay.on{display:flex}
.dots{display:flex;gap:.45rem}
.dots span{width:10px;height:10px;border-radius:50%;animation:db 1.4s ease-in-out infinite}
.dots span:nth-child(1){background:var(--accent);animation-delay:0s}
.dots span:nth-child(2){background:var(--gold);animation-delay:.2s}
.dots span:nth-child(3){background:#6366f1;animation-delay:.4s}
@keyframes db{0%,80%,100%{transform:scale(.5);opacity:.35}40%{transform:scale(1.15);opacity:1}}
.load-msg{color:var(--dim);font-size:.82rem}
.load-stat{color:var(--dim);font-size:.72rem;font-family:monospace}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-top:1rem}
.gallery-item{position:relative;border-radius:10px;overflow:hidden;border:2px solid var(--border);cursor:pointer;aspect-ratio:1}
.gallery-item:hover{border-color:var(--accent)}
.gallery-item img{width:100%;height:100%;object-fit:cover}
.gallery-item .num{position:absolute;top:5px;left:5px;background:var(--accent);color:#fff;font-size:.65rem;font-weight:700;padding:.2rem .4rem;border-radius:5px}
.hist{margin-top:1.5rem}
.hist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:.5rem;margin-top:.6rem}
.hist-item{aspect-ratio:1;border-radius:10px;overflow:hidden;cursor:pointer;border:2px solid transparent;transition:all .25s}
.hist-item:hover{border-color:var(--accent);transform:scale(1.03)}
.hist-item img{width:100%;height:100%;object-fit:cover}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(16px);background:rgba(0,0,0,.85);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.08);color:#fff;padding:.55rem 1.1rem;border-radius:9px;font-size:.82rem;opacity:0;transition:all .3s;z-index:999;pointer-events:none;display:flex;align-items:center;gap:.4rem;max-width:90%}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:rgba(0,210,106,.3)}
.toast.err{border-color:rgba(255,71,87,.3)}
.foot{text-align:center;padding:1.5rem;color:var(--dim);font-size:.72rem}
.foot a{color:var(--accent);text-decoration:none}
@media(max-width:600px){.wrap{padding:0 1rem 2.5rem}.card{padding:1rem}.controls{flex-direction:column}select,.num-input{width:100%;min-width:0}.hist-grid{grid-template-columns:repeat(auto-fill,minmax(80px,1fr))}.viewer{min-height:260px}.gallery{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>

<div class="hero">
  <h1>🏯 Asia AI Image Generator</h1>
  <p>Generate stunning Asian-themed images — unlimited, free, no signup</p>
  <div class="pills">
    <span class="pill green">✦ Unlimited</span>
    <span class="pill red">No Signup</span>
    <span class="pill yellow">⚡ Real AI</span>
    <span class="pill blue">📸 Max 5</span>
  </div>
</div>

<div class="wrap">

  <div class="card">
    <div class="label">✍️ Describe Your Image</div>
    <textarea id="prompt" rows="2" placeholder="e.g. Beautiful Japanese garden with cherry blossoms..."></textarea>
    <div class="chips">
      <span class="chip" data-p="Majestic Chinese palace at sunset, Forbidden City style">🏯 Chinese Palace</span>
      <span class="chip" data-p="Beautiful geisha in bamboo forest, traditional kimono">🎋 Geisha</span>
      <span class="chip" data-p="Floating lanterns festival over river in Thailand">🏮 Lanterns</span>
      <span class="chip" data-p="Ancient Angkor Wat temple with morning mist">🛕 Angkor Wat</span>
      <span class="chip" data-p="Korean hanbok woman in cosmos flower field">🌺 Korean</span>
      <span class="chip" data-p="Indian Holi festival with colorful powder">🎨 Holi</span>
      <span class="chip" data-p="Japanese samurai on horseback at dawn">⚔️ Samurai</span>
      <span class="chip" data-p="Vietnamese lotus pond at sunrise">🪷 Lotus</span>
      <span class="chip" data-p="Futuristic Tokyo street with neon signs at night">🏙️ Neo Tokyo</span>
      <span class="chip" data-p="Bali terraced rice paddies with farmer">🌾 Bali</span>
    </div>
  </div>

  <div class="card">
    <div class="label">⚙️ Settings</div>
    <div class="controls">
      <div class="field">
        <label>Style</label>
        <select id="styleModel">
          <option value="flataipro">✨ Flat AI Pro</option>
          <option value="realistic">📸 Realistic</option>
          <option value="retroanime">🎌 Retro Anime</option>
          <option value="flatanime">🌸 Flat Anime</option>
          <option value="ghiblistyle">🏯 Ghibli</option>
          <option value="cinematic">🎬 Cinematic</option>
          <option value="mythicfantasy">🐉 Fantasy</option>
          <option value="colorart">🎨 ColorART</option>
          <option value="realskin">👤 Real Skin</option>
          <option value="standard">🌟 Standard</option>
        </select>
      </div>
      <div class="field">
        <label>Aspect Ratio</label>
        <select id="aspectRatio">
          <option value="16:9" selected>Landscape 16:9</option>
          <option value="1:1">Square 1:1</option>
          <option value="9:16">Portrait 9:16</option>
          <option value="4:3">Standard 4:3</option>
          <option value="3:4">Portrait 3:4</option>
        </select>
      </div>
      <div class="field">
        <label>Quantity (Max 5)</label>
        <select id="quantity">
          <option value="1">1 Image</option>
          <option value="2">2 Images</option>
          <option value="3">3 Images</option>
          <option value="4">4 Images</option>
          <option value="5">5 Images</option>
        </select>
      </div>
      <div class="field">
        <label>Seed</label>
        <div class="seed-row">
          <button class="seed-btn" id="seedBtn"><i class="fas fa-dice"></i> Random</button>
          <input type="number" class="num-input" id="seedIn" placeholder="Seed #" style="display:none;width:90px">
        </div>
      </div>
    </div>
    <button class="go" id="goBtn" onclick="generate()">
      <span class="bt"><i class="fas fa-wand-magic-sparkles"></i> Generate</span>
      <div class="spin"></div>
    </button>
  </div>

  <div class="viewer" id="viewer">
    <div class="placeholder" id="ph"><div class="big">🏯</div><p>Your images appear here</p></div>
    <div class="overlay" id="overlay">
      <div class="dots"><span></span><span></span><span></span></div>
      <div class="load-msg" id="ldMsg">Connecting...</div>
      <div class="load-stat" id="ldStat"></div>
    </div>
    <img id="resultImg" alt="Generated">
    <div class="badge-seed" id="seedBadge"></div>
    <div class="actions" id="actions">
      <button class="abtn" onclick="dl()" title="Download"><i class="fas fa-download"></i></button>
      <button class="abtn" onclick="cpSeed()" title="Copy Seed"><i class="fas fa-dice"></i></button>
    </div>
  </div>

  <div id="gallerySection" style="display:none;margin-top:1rem">
    <div class="label">🖼️ All Generated Images</div>
    <div class="gallery" id="gallery"></div>
  </div>

  <div class="hist" id="histSection" style="display:none">
    <div class="label">🕐 Recent</div>
    <div class="hist-grid" id="histGrid"></div>
  </div>
</div>

<div class="foot">Powered by <a href="https://flatai.org" target="_blank">FlatAI.org</a> | Unlimited Version</div>
<div class="toast" id="toast"></div>

<script>
let seed=null,currentImages=[],busy=false,locked=false;
const H=JSON.parse(localStorage.getItem('fah_v2')||'[]');

document.querySelectorAll('.chip').forEach(c=>{
  c.onclick=()=>{document.getElementById('prompt').value=c.dataset.p}
});

const sBtn=document.getElementById('seedBtn'),sIn=document.getElementById('seedIn');
sBtn.onclick=()=>{
  locked=!locked;sBtn.classList.toggle('on',locked);
  sIn.style.display=locked?'block':'none';
  if(locked){sIn.value=seed||Math.floor(Math.random()*4294967295)}
};

async function generate(){
  if(busy)return;
  const prompt=document.getElementById('prompt').value.trim();
  if(!prompt){toast('Enter description','err');return}
  busy=true;
  const btn=document.getElementById('goBtn'),ov=document.getElementById('overlay');
  const lm=document.getElementById('ldMsg'),ls=document.getElementById('ldStat');
  btn.classList.add('loading');btn.disabled=true;ov.classList.add('on');
  lm.textContent='Connecting to FlatAI...';

  const model=document.getElementById('styleModel').value;
  const ratio=document.getElementById('aspectRatio').value;
  const qty=parseInt(document.getElementById('quantity').value)||1;
  seed=locked?parseInt(sIn.value)||Math.floor(Math.random()*4294967295):Math.floor(Math.random()*4294967295);

  let el=0;
  const si=setInterval(()=>{
    el+=2;lm.textContent=el<10?'Generating...':el<25?'AI is working...':'Almost done...';
    ls.textContent=el+'s';
  },2000);

  try{
    const r=await fetch('/api/generate',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,aspect_ratio:ratio,seed,style_model:model,enable_upscale:false,quantity:qty})
    });
    const d=await r.json();clearInterval(si);
    if(!r.ok||!d.success)throw new Error(d.error||'Failed');

    currentImages=[];
    if(d.data.results){
      d.data.results.forEach(res=>{
        if(res.images?.length){
          res.images.forEach((img,idx)=>{
            currentImages.push({url:img.url||img,seed:res.seed,index:currentImages.length+1});
          });
        }
      });
    }

    if(currentImages.length===0)throw new Error('No images');

    // Show first image
    document.getElementById('ph').style.display='none';
    document.getElementById('resultImg').style.display='block';
    document.getElementById('resultImg').src=currentImages[0].url;
    document.getElementById('seedBadge').textContent='Seed: '+currentImages[0].seed;
    document.getElementById('seedBadge').style.display='block';
    document.getElementById('actions').style.display='flex';

    // Show gallery if multiple
    if(currentImages.length>1){
      const g=document.getElementById('gallery');
      g.innerHTML=currentImages.map((img,i)=>'<div class="gallery-item" onclick="showImg('+i+')"><span class="num">#'+(i+1)+'</span><img src="'+img.url+'"></div>').join('');
      document.getElementById('gallerySection').style.display='block';
    }else{
      document.getElementById('gallerySection').style.display='none';
    }

    // Save to history
    currentImages.forEach(img=>addHist(img.url,prompt,img.seed,model));
    toast('Generated '+currentImages.length+' image(s)!','ok');

  }catch(e){clearInterval(si);toast(e.message,'err')}
  finally{busy=false;btn.classList.remove('loading');btn.disabled=false;ov.classList.remove('on')}
}

function showImg(idx){
  if(!currentImages[idx])return;
  document.getElementById('resultImg').src=currentImages[idx].url;
  document.getElementById('seedBadge').textContent='Seed: '+currentImages[idx].seed;
}

function dl(){
  if(!currentImages.length)return;
  const idx=getCurrentIdx();
  const a=document.createElement('a');a.href=currentImages[idx].url;
  a.download='flatai-'+currentImages[idx].seed+'.jpg';a.target='_blank';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  toast('Downloading...','ok');
}

function getCurrentIdx(){
  const src=document.getElementById('resultImg').src;
  return currentImages.findIndex(i=>i.url===src)||0;
}

function cpSeed(){
  if(!currentImages.length)return;
  navigator.clipboard.writeText(String(currentImages[getCurrentIdx()].seed));
  toast('Seed copied!','ok');
}

function addHist(url,p,s,m){
  H.unshift({url,prompt:p,seed:s,model:m,t:Date.now()});
  if(H.length>10)H.pop();
  try{localStorage.setItem('fah_v2',JSON.stringify(H))}catch(e){}
  renderHist();
}

function renderHist(){
  const s=document.getElementById('histSection'),g=document.getElementById('histGrid');
  if(!H.length){s.style.display='none';return}
  s.style.display='block';
  g.innerHTML=H.map((it,i)=>'<div class="hist-item" onclick="loadH('+i+')"><img src="'+it.url+'" loading="lazy"></div>').join('');
}

function loadH(i){
  const it=H[i];if(!it)return;
  currentImages=[{url:it.url,seed:it.seed,index:1}];
  document.getElementById('resultImg').src=it.url;
  document.getElementById('resultImg').style.display='block';
  document.getElementById('ph').style.display='none';
  document.getElementById('seedBadge').textContent='Seed: '+it.seed;
  document.getElementById('seedBadge').style.display='block';
  document.getElementById('actions').style.display='flex';
  document.getElementById('gallerySection').style.display='none';
  document.getElementById('prompt').value=it.prompt;
  window.scrollTo({top:0,behavior:'smooth'});
}

function toast(msg,type=''){
  const t=document.getElementById('toast');t.className='toast '+type+' show';
  t.innerHTML='<i class=\"fas fa-'+(type==='ok'?'check-circle':type==='err'?'exclamation-circle':'info-circle')+'\"></i> '+msg;
  setTimeout(()=>t.classList.remove('show'),3500);
}

document.getElementById('prompt').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();generate()}
});

renderHist();
</script>
</body>
</html>
