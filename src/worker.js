// Cloudflare Worker — FlatAI Image Generator Proxy (FIXED)
// Problem: "invalid session" error because nonce/cookies expire during polling
// Fix: Re-fetch fresh nonce+cookies before each poll attempt + retry logic

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/generate') {
      return handleGenerate(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// Fresh nonce + cookies on every call (fixes invalid session)
async function getFreshSession() {
  const pageResp = await fetch('https://flatai.org/ai-image-generator-free-no-signup/', {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
    },
  });

  const pageHtml = await pageResp.text();
  const nonceMatch = pageHtml.match(/"ai_generate_image_nonce":"([^\"]+)"/);
  const nonce = nonceMatch ? nonceMatch[1] : null;

  const cookies = [];
  const setCookies = pageResp.headers.getSetCookie?.() || [];
  if (setCookies.length === 0) {
    const sc = pageResp.headers.get('set-cookie');
    if (sc) setCookies.push(sc);
  }
  setCookies.forEach(c => cookies.push(c.split(';')[0]));
  const cookieHeader = cookies.join('; ');

  return { nonce, cookieHeader };
}

function UA_HEADERS(cookieHeader) {
  return {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'origin': 'https://flatai.org',
    'referer': 'https://flatai.org/ai-image-generator-free-no-signup/',
    'x-requested-with': 'XMLHttpRequest',
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };
}

async function handleGenerate(request) {
  try {
    const body = await request.json();
    const { prompt, aspect_ratio, seed, style_model, enable_upscale } = body;

    if (!prompt) {
      return Response.json({ error: 'Prompt is required' }, { status: 400 });
    }

    // Fresh session for initial generate
    let session = await getFreshSession();
    if (!session.nonce) {
      return Response.json({ error: 'Failed to get nonce from FlatAI' }, { status: 500 });
    }

    const usedSeed = String(seed || Math.floor(Math.random() * 4294967295));

    const genBody = new URLSearchParams({
      action: 'ai_generate_image',
      nonce: session.nonce,
      prompt,
      aspect_ratio: aspect_ratio || '1:1',
      seed: usedSeed,
      style_model: style_model || 'flataipro',
      enable_upscale: enable_upscale !== false ? 'true' : 'false',
    });

    const genResp = await fetch('https://flatai.org/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...UA_HEADERS(session.cookieHeader),
      },
      body: genBody.toString(),
    });

    const gen = await genResp.json();

    if (!gen.success) {
      return Response.json({ error: gen.data?.message || 'Generation failed' }, { status: 500 });
    }

    // Direct response with images — return immediately
    if (gen.data?.images?.length > 0 && !gen.data.pending) {
      return Response.json({ success: true, data: gen.data });
    }

    // Pending — poll with fresh session each time (THIS IS THE FIX)
    const token = gen.data?.job_token;
    if (!token) {
      return Response.json({ error: 'No job token in response' }, { status: 500 });
    }

    const start = Date.now();
    const maxWait = 55000;

    while (Date.now() - start < maxWait) {
      await sleep(3000);

      // KEY FIX: Get fresh nonce + cookies before every poll
      try {
        session = await getFreshSession();
        if (!session.nonce) continue;
      } catch {
        continue;
      }

      const pollBody = new URLSearchParams({
        action: 'ai_poll_generation_status',
        nonce: session.nonce,
        job_token: token,
      });

      try {
        const pollResp = await fetch('https://flatai.org/wp-admin/admin-ajax.php', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            ...UA_HEADERS(session.cookieHeader),
          },
          body: pollBody.toString(),
        });

        const p = await pollResp.json();

        if (!p.success) {
          const msg = p.data?.message || 'Poll failed';
          if (/expired|invalid/i.test(msg)) {
            continue;
          }
          continue;
        }

        if (p.data?.pending) continue;

        return Response.json({ success: true, data: { ...p.data, seed: usedSeed } });

      } catch {
        continue;
      }
    }

    return Response.json({ error: 'Generation timed out' }, { status: 504 });

  } catch (err) {
    return Response.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== EMBEDDED HTML =====
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Asia AI Image Generator — FlatAI</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0b14;
  --surface:#131320;
  --card:#191930;
  --border:#2e2e50;
  --accent:#e94560;
  --accent-glow:rgba(233,69,96,.3);
  --gold:#f5c518;
  --text:#ececf5;
  --dim:#7a7a9e;
  --ok:#00d26a;
  --err:#ff4757;
  --r:14px;
}
html{scroll-behavior:smooth}
body{
  font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;
  background-image:
    radial-gradient(ellipse at 15% 50%,rgba(233,69,96,.05) 0%,transparent 55%),
    radial-gradient(ellipse at 85% 15%,rgba(99,102,241,.08) 0%,transparent 50%);
}

.hero{text-align:center;padding:3.5rem 1.5rem 2rem}
.hero h1{
  font-size:clamp(1.6rem,5vw,2.8rem);font-weight:800;
  background:linear-gradient(135deg,#fff 15%,var(--accent) 55%,var(--gold) 90%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  line-height:1.2;margin-bottom:.4rem;
}
.hero p{color:var(--dim);font-size:.95rem;max-width:480px;margin:0 auto}
.pills{display:flex;gap:.4rem;justify-content:center;margin-top:1rem;flex-wrap:wrap}
.pill{font-size:.68rem;font-weight:600;padding:.25rem .65rem;border-radius:20px;text-transform:uppercase;letter-spacing:.4px}
.pill.green{background:rgba(0,210,106,.1);color:var(--ok);border:1px solid rgba(0,210,106,.2)}
.pill.red{background:rgba(233,69,96,.08);color:var(--accent);border:1px solid rgba(233,69,96,.15)}
.pill.yellow{background:rgba(245,197,24,.08);color:var(--gold);border:1px solid rgba(245,197,24,.15)}

.wrap{max-width:920px;margin:0 auto;padding:0 1.25rem 3rem}

.card{
  background:var(--card);border:1px solid var(--border);
  border-radius:var(--r);padding:1.5rem;margin-bottom:1.25rem;
  box-shadow:0 6px 28px rgba(0,0,0,.25);
}
.label{font-size:.75rem;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;margin-bottom:.65rem}

textarea#prompt{
  width:100%;background:var(--bg);border:2px solid var(--border);
  border-radius:10px;padding:.8rem 1rem;font-size:.95rem;color:var(--text);
  resize:none;min-height:60px;max-height:180px;font-family:inherit;
  transition:border-color .2s;line-height:1.5;
}
textarea#prompt::placeholder{color:var(--dim)}
textarea#prompt:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}

.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.75rem}
.chip{
  background:rgba(255,255,255,.03);border:1px solid var(--border);
  border-radius:20px;padding:.35rem .7rem;font-size:.72rem;color:var(--dim);
  cursor:pointer;transition:all .2s;white-space:nowrap;
}
.chip:hover{background:rgba(233,69,96,.08);border-color:var(--accent);color:var(--text)}

.controls{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:.25rem}
.field label{font-size:.68rem;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
select,.num-input{
  background:var(--bg);border:2px solid var(--border);border-radius:10px;
  padding:.55rem .75rem;color:var(--text);font-size:.83rem;
  min-width:110px;transition:border-color .2s;cursor:pointer;
}
select:focus,.num-input:focus{outline:none;border-color:var(--accent)}
select option{background:var(--card);color:var(--text)}
.seed-row{display:flex;gap:.4rem;align-items:center}
.seed-btn{
  background:rgba(233,69,96,.06);border:2px solid var(--border);border-radius:10px;
  padding:.55rem .75rem;color:var(--dim);font-size:.78rem;cursor:pointer;
  transition:all .2s;font-weight:700;white-space:nowrap;
}
.seed-btn.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.seed-btn:hover{border-color:var(--accent)}

.go{
  width:100%;padding:.85rem;border:none;border-radius:10px;
  font-size:1.05rem;font-weight:700;cursor:pointer;
  background:linear-gradient(135deg,var(--accent),#c0392b);color:#fff;
  transition:all .3s;display:flex;align-items:center;justify-content:center;gap:.5rem;
  box-shadow:0 4px 18px var(--accent-glow);letter-spacing:.2px;margin-top:1.25rem;
}
.go:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 28px var(--accent-glow)}
.go:disabled{opacity:.5;cursor:not-allowed}
.go.loading{background:linear-gradient(135deg,#6366f1,#4f46e5)}
.go .spin{display:none;width:20px;height:20px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:sp .8s linear infinite}
.go.loading .spin{display:block}
.go.loading .bt{display:none}
@keyframes sp{to{transform:rotate(360deg)}}

.viewer{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  overflow:hidden;position:relative;min-height:380px;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 6px 28px rgba(0,0,0,.25);
}
.placeholder{text-align:center;color:var(--dim);padding:2rem}
.placeholder .big{font-size:2.8rem;margin-bottom:.6rem;opacity:.35}
#resultImg{width:100%;height:auto;display:none;animation:fi .5s ease}
@keyframes fi{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
.badge-seed{
  position:absolute;top:10px;left:10px;background:rgba(0,0,0,.55);
  backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.08);
  color:rgba(255,255,255,.75);font-size:.68rem;font-weight:600;
  padding:.25rem .55rem;border-radius:8px;font-family:monospace;display:none;
}
.actions{position:absolute;bottom:10px;right:10px;display:none;gap:.4rem}
.abtn{
  background:rgba(0,0,0,.55);backdrop-filter:blur(6px);
  border:1px solid rgba(255,255,255,.12);color:#fff;
  width:36px;height:36px;border-radius:9px;display:flex;
  align-items:center;justify-content:center;cursor:pointer;
  transition:all .2s;font-size:.85rem;
}
.abtn:hover{background:rgba(233,69,96,.65);transform:translateY(-1px)}

.overlay{
  position:absolute;inset:0;background:rgba(11,11,20,.85);
  display:none;align-items:center;justify-content:center;
  flex-direction:column;gap:.8rem;z-index:5;backdrop-filter:blur(4px);
}
.overlay.on{display:flex}
.dots{display:flex;gap:.45rem}
.dots span{width:10px;height:10px;border-radius:50%;animation:db 1.4s ease-in-out infinite}
.dots span:nth-child(1){background:var(--accent);animation-delay:0s}
.dots span:nth-child(2){background:var(--gold);animation-delay:.2s}
.dots span:nth-child(3){background:#6366f1;animation-delay:.4s}
@keyframes db{0%,80%,100%{transform:scale(.5);opacity:.35}40%{transform:scale(1.15);opacity:1}}
.load-msg{color:var(--dim);font-size:.82rem}
.load-stat{color:var(--dim);font-size:.72rem;font-family:monospace}

.hist{margin-top:1.5rem}
.hist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.6rem;margin-top:.6rem}
.hist-item{
  aspect-ratio:1;border-radius:10px;overflow:hidden;cursor:pointer;
  border:2px solid transparent;transition:all .25s;
}
.hist-item:hover{border-color:var(--accent);transform:scale(1.03)}
.hist-item img{width:100%;height:100%;object-fit:cover}

.toast{
  position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(16px);
  background:rgba(0,0,0,.85);backdrop-filter:blur(8px);
  border:1px solid rgba(255,255,255,.08);color:#fff;
  padding:.55rem 1.1rem;border-radius:9px;font-size:.82rem;
  opacity:0;transition:all .3s;z-index:999;pointer-events:none;
  display:flex;align-items:center;gap:.4rem;max-width:90%;
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:rgba(0,210,106,.3)}
.toast.err{border-color:rgba(255,71,87,.3)}

.foot{text-align:center;padding:1.5rem;color:var(--dim);font-size:.72rem}
.foot a{color:var(--accent);text-decoration:none}

@media(max-width:600px){
  .wrap{padding:0 1rem 2.5rem}
  .card{padding:1rem}
  .controls{flex-direction:column}
  select,.num-input{width:100%;min-width:0}
  .hist-grid{grid-template-columns:repeat(auto-fill,minmax(90px,1fr))}
  .viewer{min-height:260px}
}
</style>
</head>
<body>

<div class="hero">
  <h1>🏯 Asia AI Image Generator</h1>
  <p>Generate stunning Asian-themed images with FlatAI — free, real AI, no signup</p>
  <div class="pills">
    <span class="pill green">✦ FlatAI API</span>
    <span class="pill red">No Signup</span>
    <span class="pill yellow">⚡ Real AI</span>
  </div>
</div>

<div class="wrap">

  <div class="card">
    <div class="label">✍️ Describe Your Image</div>
    <textarea id="prompt" rows="2" placeholder="e.g. Beautiful Japanese garden with cherry blossoms, koi pond, torii gate at golden hour..."></textarea>
    <div class="chips">
      <span class="chip" data-p="Majestic Chinese palace at sunset with golden clouds, Forbidden City style architecture">🏯 Chinese Palace</span>
      <span class="chip" data-p="Beautiful geisha walking through bamboo forest, soft morning light, traditional kimono">🎋 Geisha</span>
      <span class="chip" data-p="Floating lanterns festival over calm river in Thailand, warm golden glow, night sky">🏮 Lanterns</span>
      <span class="chip" data-p="Ancient Angkor Wat temple ruins overgrown with jungle vines, mystical morning mist">🛕 Angkor Wat</span>
      <span class="chip" data-p="Korean hanbok woman in field of pink cosmos flowers, autumn mountain backdrop">🌺 Korean</span>
      <span class="chip" data-p="Indian Holi festival celebration, vibrant colored powder explosion, joyful faces">🎨 Holi</span>
      <span class="chip" data-p="Japanese samurai on horseback crossing misty mountain pass at dawn, epic landscape">⚔️ Samurai</span>
      <span class="chip" data-p="Vietnamese lotus pond at sunrise, traditional conical hat woman rowing boat">🪷 Lotus</span>
      <span class="chip" data-p="Futuristic Tokyo street at night with holographic signs in Japanese, rain reflections">🏙️ Neo Tokyo</span>
      <span class="chip" data-p="Terraced rice paddies in Bali glowing emerald green, farmer with water buffalo">🌾 Bali</span>
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
        <label>Seed</label>
        <div class="seed-row">
          <button class="seed-btn" id="seedBtn"><i class="fas fa-dice"></i> Random</button>
          <input type="number" class="num-input" id="seedIn" placeholder="Seed #" style="display:none;width:90px;min-width:70px">
        </div>
      </div>
    </div>
    <button class="go" id="goBtn" onclick="generate()">
      <span class="bt"><i class="fas fa-wand-magic-sparkles"></i> Generate Image</span>
      <div class="spin"></div>
    </button>
  </div>

  <div class="viewer" id="viewer">
    <div class="placeholder" id="ph"><div class="big">🏯</div><p>Your generated image appears here</p></div>
    <div class="overlay" id="overlay">
      <div class="dots"><span></span><span></span><span></span></div>
      <div class="load-msg" id="ldMsg">Connecting to FlatAI...</div>
      <div class="load-stat" id="ldStat"></div>
    </div>
    <img id="resultImg" alt="Generated image">
    <div class="badge-seed" id="seedBadge"></div>
    <div class="actions" id="actions">
      <button class="abtn" onclick="dl()" title="Download"><i class="fas fa-download"></i></button>
      <button class="abtn" onclick="cpSeed()" title="Copy Seed"><i class="fas fa-dice"></i></button>
    </div>
  </div>

  <div class="hist" id="histSection" style="display:none">
    <div class="label">🕐 Recent Generations</div>
    <div class="hist-grid" id="histGrid"></div>
  </div>
</div>

<div class="foot">Powered by <a href="https://flatai.org" target="_blank">FlatAI.org</a></div>
<div class="toast" id="toast"></div>

<script>
let seed=null,prompt='',imgUrl='',busy=false,locked=false;
const H=JSON.parse(localStorage.getItem('fah')||'[]');

document.querySelectorAll('.chip').forEach(c=>{
  c.onclick=()=>{const t=document.getElementById('prompt');t.value=c.dataset.p;t.focus()}
});

const sBtn=document.getElementById('seedBtn'),sIn=document.getElementById('seedIn');
sBtn.onclick=()=>{
  locked=!locked;sBtn.classList.toggle('on',locked);
  sIn.style.display=locked?'block':'none';
  if(locked){sIn.value=seed||Math.floor(Math.random()*4294967295);sIn.focus()}
};

async function generate(){
  if(busy)return;
  prompt=document.getElementById('prompt').value.trim();
  if(!prompt){toast('Enter a description','err');document.getElementById('prompt').focus();return}
  busy=true;
  const btn=document.getElementById('goBtn'),ov=document.getElementById('overlay');
  const lm=document.getElementById('ldMsg'),ls=document.getElementById('ldStat');
  btn.classList.add('loading');btn.disabled=true;ov.classList.add('on');
  lm.textContent='Connecting to FlatAI...';ls.textContent='';

  const model=document.getElementById('styleModel').value;
  const ratio=document.getElementById('aspectRatio').value;
  seed=locked?parseInt(sIn.value)||Math.floor(Math.random()*4294967295):Math.floor(Math.random()*4294967295);

  let el=0;
  const si=setInterval(()=>{
    el+=2;
    if(el<8)lm.textContent='Sending to FlatAI...';
    else if(el<20){lm.textContent='AI is generating...';ls.textContent=el+'s elapsed'}
    else{lm.textContent='Still working...';ls.textContent=el+'s — complex images take time'}
  },2000);

  try{
    const r=await fetch('/api/generate',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,aspect_ratio:ratio,seed,style_model:model,enable_upscale:false})
    });
    const d=await r.json();clearInterval(si);
    if(!r.ok||!d.success)throw new Error(d.error||'Failed');

    const res=d.data;
    let url=null;
    if(res.images&&res.images.length>0)url=res.images[0].url||res.images[0];
    else if(res.image_url)url=res.image_url;
    else if(res.url)url=res.url;
    else if(res.originalUrl)url=res.originalUrl;

    if(!url){toast('No image in response','err');return}

    imgUrl=url;
    const img=document.getElementById('resultImg');
    document.getElementById('ph').style.display='none';
    img.style.display='block';img.src=url;
    document.getElementById('seedBadge').textContent='Seed: '+seed;
    document.getElementById('seedBadge').style.display='block';
    document.getElementById('actions').style.display='flex';
    addHist(url,prompt,seed,model);
    toast('Image generated!','ok');
  }catch(e){clearInterval(si);toast(e.message,'err')}
  finally{busy=false;btn.classList.remove('loading');btn.disabled=false;ov.classList.remove('on')}
}

function dl(){
  if(!imgUrl)return;
  const a=document.createElement('a');a.href=imgUrl;
  a.download='flatai-'+(seed||'image')+'.jpg';a.target='_blank';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  toast('Downloading...','ok');
}
function cpSeed(){navigator.clipboard.writeText(String(seed));toast('Seed copied!','ok')}

function addHist(url,p,sm,m){
  H.unshift({url,prompt:p,seed,model:m,t:Date.now()});
  if(H.length>8)H.pop();
  try{localStorage.setItem('fah',JSON.stringify(H))}catch(e){}
  renderHist();
}
function renderHist(){
  const s=document.getElementById('histSection'),g=document.getElementById('histGrid');
  if(!H.length){s.style.display='none';return}
  s.style.display='block';
  g.innerHTML=H.filter(i=>i.url).map((it,i)=>
    '<div class="hist-item" onclick="loadH('+H.indexOf(it)+')" title="'+it.prompt.replace(/"/g,'&quot;')+'"><img src="'+it.url+'" alt="" loading="lazy"></div>'
  ).join('');
}
function loadH(i){
  const it=H[i];if(!it||!it.url)return;
  const img=document.getElementById('resultImg');img.src=it.url;img.style.display='block';
  document.getElementById('ph').style.display='none';
  document.getElementById('seedBadge').textContent='Seed: '+it.seed;
  document.getElementById('seedBadge').style.display='block';
  document.getElementById('actions').style.display='flex';
  document.getElementById('prompt').value=it.prompt;
  seed=it.seed;prompt=it.prompt;imgUrl=it.url;
  window.scrollTo({top:0,behavior:'smooth'});
}

function toast(msg,type=''){
  const t=document.getElementById('toast');t.className='toast '+type+' show';
  t.innerHTML='<i class="fas fa-'+(type==='ok'?'check-circle':type==='err'?'exclamation-circle':'info-circle')+'"></i> '+msg;
  setTimeout(()=>t.classList.remove('show'),3500);
}

document.getElementById('prompt').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();generate()}
});
renderHist();
</script>
</body>
</html>`;
