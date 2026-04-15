// Cloudflare Worker — FlatAI Asia Image Generator Proxy
// Serves HTML on GET / and proxies generate requests on POST /api/generate

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Serve HTML page
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    // Health check
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    // Generate endpoint
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      return handleGenerate(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleGenerate(request) {
  try {
    const body = await request.json();
    const { prompt, aspect_ratio, seed, style_model, enable_upscale } = body;

    if (!prompt) {
      return Response.json({ error: 'Prompt is required' }, { status: 400 });
    }

    // Step 1: Get fresh nonce from FlatAI page
    const pageResp = await fetch('https://flatai.org/ai-image-generator-free-no-signup/', {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
      },
    });

    const pageHtml = await pageResp.text();
    const nonceMatch = pageHtml.match(/"ai_generate_image_nonce":"([^"]+)"/);
    const nonce = nonceMatch ? nonceMatch[1] : null;

    if (!nonce) {
      return Response.json({ error: 'Failed to get nonce from FlatAI' }, { status: 500 });
    }

    // Step 2: Extract cookies from page response
    const cookies = [];
    const setCookies = pageResp.headers.getSetCookie?.() || [];
    // Fallback for older runtimes
    if (setCookies.length === 0) {
      const sc = pageResp.headers.get('set-cookie');
      if (sc) setCookies.push(sc);
    }
    setCookies.forEach(c => cookies.push(c.split(';')[0]));
    const cookieHeader = cookies.join('; ');

    // Step 3: Generate image
    const genBody = new URLSearchParams({
      action: 'ai_generate_image',
      nonce,
      prompt,
      aspect_ratio: aspect_ratio || '1:1',
      seed: String(seed || Math.floor(Math.random() * 4294967295)),
      style_model: style_model || 'flataipro',
      enable_upscale: enable_upscale !== false ? 'true' : 'false',
    });

    const genResp = await fetch('https://flatai.org/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'origin': 'https://flatai.org',
        'referer': 'https://flatai.org/ai-image-generator-free-no-signup/',
        'x-requested-with': 'XMLHttpRequest',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: genBody.toString(),
    });

    const gen = await genResp.json();

    if (!gen.success) {
      return Response.json({ error: gen.data?.message || 'Generation failed' }, { status: 500 });
    }

    // Step 4: If direct response with images, return immediately
    if (gen.data?.images?.length > 0 && !gen.data.pending) {
      return Response.json({ success: true, data: gen.data });
    }

    // Step 5: Pending — poll for result (up to 60s for Workers CPU limits)
    const token = gen.data?.job_token;
    if (!token) {
      return Response.json({ error: 'No job token in response' }, { status: 500 });
    }

    const start = Date.now();
    const maxWait = 55000; // Workers free tier ~30s, paid ~60s

    while (Date.now() - start < maxWait) {
      await sleep(3000);

      const pollBody = new URLSearchParams({
        action: 'ai_poll_generation_status',
        nonce,
        job_token: token,
      });

      try {
        const pollResp = await fetch('https://flatai.org/wp-admin/admin-ajax.php', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
            'origin': 'https://flatai.org',
            'referer': 'https://flatai.org/ai-image-generator-free-no-signup/',
            'x-requested-with': 'XMLHttpRequest',
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          body: pollBody.toString(),
        });

        const p = await pollResp.json();

        if (!p.success) {
          const msg = p.data?.message || 'Poll failed';
          if (/expired|invalid/i.test(msg)) {
            return Response.json({ error: msg }, { status: 500 });
          }
          continue; // transient error, retry
        }

        if (p.data?.pending) continue;

        // Done!
        return Response.json({ success: true, data: p.data });

      } catch {
        continue; // transient network error, retry
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a12;--surface:#12121f;--card:#1a1a2e;--border:#2a2a4a;--primary:#e94560;--primary-glow:rgba(233,69,96,.35);--gold:#f5c518;--text:#e8e8f0;--text-dim:#8888aa;--success:#00d26a;--error:#ff4757;--radius:16px;--radius-sm:10px}
html{scroll-behavior:smooth}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;background-image:radial-gradient(ellipse at 20% 50%,rgba(233,69,96,.06) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(15,52,96,.12) 0%,transparent 50%),radial-gradient(ellipse at 50% 80%,rgba(245,197,24,.04) 0%,transparent 40%)}
.header{text-align:center;padding:3rem 1.5rem 2rem;position:relative}
.header::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:80px;height:2px;background:linear-gradient(90deg,transparent,var(--primary),var(--gold),transparent);border-radius:2px}
.header h1{font-size:clamp(1.8rem,5vw,3rem);font-weight:800;background:linear-gradient(135deg,#fff 20%,var(--primary) 50%,var(--gold) 80%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.02em;line-height:1.2;margin-bottom:.5rem}
.header .subtitle{color:var(--text-dim);font-size:1rem;max-width:520px;margin:0 auto}
.badges{display:flex;gap:.5rem;justify-content:center;margin-top:1rem;flex-wrap:wrap}
.badge{font-size:.7rem;font-weight:600;padding:.3rem .7rem;border-radius:20px;text-transform:uppercase;letter-spacing:.5px}
.badge.api{background:rgba(0,210,106,.12);color:var(--success);border:1px solid rgba(0,210,106,.25)}
.badge.nosignup{background:rgba(233,69,96,.1);color:var(--primary);border:1px solid rgba(233,69,96,.2)}
.badge.fast{background:rgba(245,197,24,.1);color:var(--gold);border:1px solid rgba(245,197,24,.2)}
.container{max-width:960px;margin:0 auto;padding:1rem 1.5rem 3rem}
.generator{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;margin-bottom:1.5rem;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.section-label{font-size:.8rem;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.style-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:.5rem;margin-bottom:1.25rem}
.style-card{background:rgba(255,255,255,.03);border:2px solid transparent;border-radius:var(--radius-sm);padding:.6rem .4rem;text-align:center;cursor:pointer;transition:all .25s ease}
.style-card:hover{background:rgba(233,69,96,.08);transform:translateY(-2px)}
.style-card.active{border-color:var(--primary);background:rgba(233,69,96,.12);box-shadow:0 0 16px var(--primary-glow)}
.style-card .icon{font-size:1.5rem;margin-bottom:.25rem}
.style-card .name{font-size:.72rem;font-weight:600;color:var(--text);line-height:1.2}
.prompt-section{margin-bottom:1.25rem}
.prompt-input{width:100%;background:var(--bg);border:2px solid var(--border);border-radius:var(--radius-sm);padding:.85rem 1rem;font-size:.95rem;color:var(--text);resize:none;min-height:56px;max-height:160px;font-family:inherit;transition:border-color .2s;line-height:1.5}
.prompt-input::placeholder{color:var(--text-dim)}
.prompt-input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-glow)}
.suggestions{margin-top:1rem}
.suggestion-chips{display:flex;flex-wrap:wrap;gap:.4rem}
.chip{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:20px;padding:.4rem .8rem;font-size:.75rem;color:var(--text-dim);cursor:pointer;transition:all .2s;white-space:nowrap}
.chip:hover{background:rgba(233,69,96,.1);border-color:var(--primary);color:var(--text)}
.controls{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;margin-bottom:1.25rem}
.control-group{display:flex;flex-direction:column;gap:.3rem}
.control-label{font-size:.7rem;color:var(--text-dim);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.control-select,.control-input{background:var(--bg);border:2px solid var(--border);border-radius:var(--radius-sm);padding:.6rem .8rem;color:var(--text);font-size:.85rem;min-width:120px;transition:border-color .2s;cursor:pointer}
.control-select:focus,.control-input:focus{outline:none;border-color:var(--primary)}
.control-select option{background:var(--card);color:var(--text)}
.seed-row{display:flex;gap:.5rem;align-items:center}
.seed-toggle{background:rgba(233,69,96,.08);border:2px solid var(--border);border-radius:var(--radius-sm);padding:.6rem .8rem;color:var(--text-dim);font-size:.8rem;cursor:pointer;transition:all .2s;font-weight:600;white-space:nowrap}
.seed-toggle.active{background:var(--primary);color:#fff;border-color:var(--primary)}
.seed-toggle:hover{border-color:var(--primary)}
.generate-btn{width:100%;padding:.9rem;border:none;border-radius:var(--radius-sm);font-size:1.1rem;font-weight:700;cursor:pointer;background:linear-gradient(135deg,var(--primary),#c0392b);color:#fff;transition:all .3s ease;display:flex;align-items:center;justify-content:center;gap:.6rem;box-shadow:0 4px 20px var(--primary-glow);letter-spacing:.3px}
.generate-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 30px var(--primary-glow)}
.generate-btn:disabled{opacity:.5;cursor:not-allowed}
.generate-btn.loading{background:linear-gradient(135deg,#6366f1,#4f46e5)}
.generate-btn .spinner{display:none;width:22px;height:22px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
.generate-btn.loading .spinner{display:block}
.generate-btn.loading .btn-text{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
.image-container{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;position:relative;min-height:400px;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.image-placeholder{text-align:center;color:var(--text-dim);padding:2rem}
.image-placeholder .icon{font-size:3rem;margin-bottom:.75rem;opacity:.4}
.generated-img{width:100%;height:auto;display:block;animation:fadeIn .6s ease}
@keyframes fadeIn{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}
.image-actions{position:absolute;bottom:12px;right:12px;display:flex;gap:.5rem;opacity:0;transition:opacity .3s}
.image-container:hover .image-actions{opacity:1}
.img-action-btn{background:rgba(0,0,0,.6);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.15);color:#fff;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;font-size:.9rem}
.img-action-btn:hover{background:rgba(233,69,96,.7);transform:translateY(-2px)}
.seed-badge{position:absolute;top:12px;left:12px;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.8);font-size:.7rem;font-weight:600;padding:.3rem .6rem;border-radius:8px;font-family:monospace}
.loading-overlay{position:absolute;inset:0;background:rgba(10,10,18,.85);display:none;align-items:center;justify-content:center;flex-direction:column;gap:1rem;z-index:5;backdrop-filter:blur(4px)}
.loading-overlay.active{display:flex}
.loading-dots{display:flex;gap:.5rem}
.loading-dots span{width:12px;height:12px;border-radius:50%;animation:dotBounce 1.4s ease-in-out infinite}
.loading-dots span:nth-child(1){background:var(--primary);animation-delay:0s}
.loading-dots span:nth-child(2){background:var(--gold);animation-delay:.2s}
.loading-dots span:nth-child(3){background:#6366f1;animation-delay:.4s}
@keyframes dotBounce{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1.2);opacity:1}}
.loading-text{color:var(--text-dim);font-size:.85rem}
.loading-status{color:var(--text-dim);font-size:.75rem;font-family:monospace}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(0,0,0,.85);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);color:#fff;padding:.6rem 1.2rem;border-radius:10px;font-size:.85rem;opacity:0;transition:all .3s;z-index:999;pointer-events:none;display:flex;align-items:center;gap:.5rem;max-width:90%}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.footer{text-align:center;padding:2rem;color:var(--text-dim);font-size:.75rem}
.footer a{color:var(--primary);text-decoration:none}
.footer a:hover{text-decoration:underline}
.history-section{margin-top:2rem}
.history-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.75rem;margin-top:.75rem}
.history-item{aspect-ratio:1;border-radius:var(--radius-sm);overflow:hidden;cursor:pointer;border:2px solid transparent;transition:all .25s}
.history-item:hover{border-color:var(--primary);transform:scale(1.03)}
.history-item img{width:100%;height:100%;object-fit:cover}
@media(max-width:600px){.container{padding:1rem}.generator{padding:1rem}.style-grid{grid-template-columns:repeat(auto-fill,minmax(80px,1fr))}.controls{flex-direction:column}.control-select,.control-input{width:100%;min-width:0}.history-grid{grid-template-columns:repeat(auto-fill,minmax(100px,1fr))}.image-container{min-height:280px}}
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
</head>
<body>

<div class="header">
  <h1>🏯 Asia AI Image Generator</h1>
  <p class="subtitle">Generate stunning Asian-themed images via FlatAI — free, real AI, no signup</p>
  <div class="badges">
    <span class="badge api">✦ FlatAI API</span>
    <span class="badge nosignup">No Signup</span>
    <span class="badge fast">⚡ Real AI Images</span>
  </div>
</div>

<div class="container">
  <div class="generator">
    <div class="section-label">🎨 Choose Style</div>
    <div class="style-grid" id="styleGrid">
      <div class="style-card active" data-model="flataipro"><div class="icon">✨</div><div class="name">Flat AI Pro</div></div>
      <div class="style-card" data-model="realistic"><div class="icon">📸</div><div class="name">Realistic</div></div>
      <div class="style-card" data-model="retroanime"><div class="icon">🎌</div><div class="name">Retro Anime</div></div>
      <div class="style-card" data-model="flatanime"><div class="icon">🌸</div><div class="name">Flat Anime</div></div>
      <div class="style-card" data-model="ghiblistyle"><div class="icon">🏯</div><div class="name">Ghibli</div></div>
      <div class="style-card" data-model="cinematic"><div class="icon">🎬</div><div class="name">Cinematic</div></div>
      <div class="style-card" data-model="mythicfantasy"><div class="icon">🐉</div><div class="name">Fantasy</div></div>
      <div class="style-card" data-model="colorart"><div class="icon">🎨</div><div class="name">ColorART</div></div>
      <div class="style-card" data-model="realskin"><div class="icon">👤</div><div class="name">Real Skin</div></div>
      <div class="style-card" data-model="standard"><div class="icon">🌟</div><div class="name">Standard</div></div>
    </div>

    <div class="prompt-section">
      <div class="section-label">✍️ Describe Your Image</div>
      <textarea class="prompt-input" id="promptInput" rows="2" placeholder="e.g. Beautiful Japanese garden with cherry blossoms, koi pond, torii gate at golden hour..."></textarea>
      <div class="suggestions">
        <div class="section-label" style="margin-top:.5rem">💡 Quick Prompts</div>
        <div class="suggestion-chips">
          <span class="chip" data-prompt="Majestic Chinese palace at sunset with golden clouds, Forbidden City style architecture">🏯 Chinese Palace</span>
          <span class="chip" data-prompt="Beautiful geisha walking through bamboo forest, soft morning light, traditional kimono">🎋 Geisha</span>
          <span class="chip" data-prompt="Floating lanterns festival over calm river in Thailand, warm golden glow, night sky">🏮 Lanterns</span>
          <span class="chip" data-prompt="Ancient Angkor Wat temple ruins overgrown with jungle vines, mystical morning mist">🛕 Angkor Wat</span>
          <span class="chip" data-prompt="Korean hanbok woman in field of pink cosmos flowers, autumn mountain backdrop">🌺 Korean</span>
          <span class="chip" data-prompt="Indian Holi festival celebration, vibrant colored powder explosion, joyful faces">🎨 Holi</span>
          <span class="chip" data-prompt="Japanese samurai on horseback crossing misty mountain pass at dawn, epic landscape">⚔️ Samurai</span>
          <span class="chip" data-prompt="Vietnamese lotus pond at sunrise, traditional conical hat woman rowing boat">🪷 Lotus</span>
          <span class="chip" data-prompt="Futuristic Tokyo street at night with holographic signs in Japanese, rain reflections">🏙️ Neo Tokyo</span>
          <span class="chip" data-prompt="Terraced rice paddies in Bali glowing emerald green, farmer with water buffalo">🌾 Bali</span>
        </div>
      </div>
    </div>

    <div class="controls">
      <div class="control-group">
        <span class="control-label">Aspect Ratio</span>
        <select class="control-select" id="aspectRatio">
          <option value="1:1">Square 1:1</option>
          <option value="16:9" selected>Landscape 16:9</option>
          <option value="9:16">Portrait 9:16</option>
          <option value="4:3">Standard 4:3</option>
          <option value="3:4">Portrait 3:4</option>
        </select>
      </div>
      <div class="control-group">
        <span class="control-label">Seed</span>
        <div class="seed-row">
          <button class="seed-toggle" id="seedToggle"><i class="fas fa-dice"></i> Random</button>
          <input type="number" class="control-input" id="seedInput" placeholder="Seed #" style="display:none;width:100px;min-width:80px">
        </div>
      </div>
    </div>

    <button class="generate-btn" id="generateBtn" onclick="generateImage()">
      <span class="btn-text"><i class="fas fa-wand-magic-sparkles"></i> Generate Image</span>
      <div class="spinner"></div>
    </button>
  </div>

  <div class="image-container" id="imageContainer">
    <div class="image-placeholder" id="placeholder"><div class="icon">🏯</div><p>Your FlatAI generated image will appear here</p></div>
    <div class="loading-overlay" id="loadingOverlay">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <div class="loading-text" id="loadingText">Connecting to FlatAI...</div>
      <div class="loading-status" id="loadingStatus"></div>
    </div>
    <img class="generated-img" id="generatedImg" style="display:none" alt="Generated image">
    <div class="seed-badge" id="seedBadge" style="display:none"></div>
    <div class="image-actions" id="imageActions" style="display:none">
      <button class="img-action-btn" onclick="downloadImage()" title="Download"><i class="fas fa-download"></i></button>
      <button class="img-action-btn" onclick="copySeed()" title="Copy Seed"><i class="fas fa-dice"></i></button>
    </div>
  </div>

  <div class="history-section" id="historySection" style="display:none">
    <div class="section-label">🕐 Recent Generations</div>
    <div class="history-grid" id="historyGrid"></div>
  </div>
</div>

<div class="footer">Powered by <a href="https://flatai.org" target="_blank">FlatAI.org</a> via Cloudflare Worker</div>
<div class="toast" id="toast"></div>

<script>
let currentSeed=null,currentPrompt='',currentImageUrl='',isGenerating=false,seedLocked=false;
const history=JSON.parse(localStorage.getItem('flataiHist')||'[]');

document.querySelectorAll('.style-card').forEach(c=>{c.addEventListener('click',()=>{document.querySelectorAll('.style-card').forEach(x=>x.classList.remove('active'));c.classList.add('active')})});
document.querySelectorAll('.chip').forEach(c=>{c.addEventListener('click',()=>{document.getElementById('promptInput').value=c.dataset.prompt;document.getElementById('promptInput').focus()})});

const seedToggle=document.getElementById('seedToggle'),seedInput=document.getElementById('seedInput');
seedToggle.addEventListener('click',()=>{seedLocked=!seedLocked;seedToggle.classList.toggle('active',seedLocked);seedInput.style.display=seedLocked?'block':'none';if(seedLocked){seedInput.value=currentSeed||Math.floor(Math.random()*4294967295);seedInput.focus()}});

async function generateImage(){
  if(isGenerating)return;
  const prompt=document.getElementById('promptInput').value.trim();
  if(!prompt){showToast('Enter a description','error');document.getElementById('promptInput').focus();return}
  isGenerating=true;currentPrompt=prompt;
  const btn=document.getElementById('generateBtn'),overlay=document.getElementById('loadingOverlay');
  const loadingText=document.getElementById('loadingText'),loadingStatus=document.getElementById('loadingStatus');
  btn.classList.add('loading');btn.disabled=true;overlay.classList.add('active');
  loadingText.textContent='Connecting to FlatAI...';loadingStatus.textContent='';

  const activeStyle=document.querySelector('.style-card.active');
  const model=activeStyle?.dataset?.model||'flataipro';
  const ratio=document.getElementById('aspectRatio').value;
  const seed=seedLocked?parseInt(seedInput.value)||Math.floor(Math.random()*4294967295):Math.floor(Math.random()*4294967295);
  currentSeed=seed;

  let elapsed=0;
  const si=setInterval(()=>{elapsed+=2;if(elapsed<8)loadingText.textContent='Sending to FlatAI...';else if(elapsed<20){loadingText.textContent='AI is generating...';loadingStatus.textContent=elapsed+'s elapsed'}else{loadingText.textContent='Still working...';loadingStatus.textContent=elapsed+'s — complex images take time'}},2000);

  try{
    const resp=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,aspect_ratio:ratio,seed,style_model:model,enable_upscale:false})});
    const data=await resp.json();clearInterval(si);
    if(!resp.ok||!data.success)throw new Error(data.error||'Failed');

    const result=data.data;
    let imageUrl=null;
    if(result.images&&result.images.length>0)imageUrl=result.images[0].url||result.images[0];
    else if(result.image_url)imageUrl=result.image_url;
    else if(result.url)imageUrl=result.url;
    else if(result.originalUrl)imageUrl=result.originalUrl;

    if(!imageUrl){showToast('No image in response','error');return}

    currentImageUrl=imageUrl;
    const img=document.getElementById('generatedImg');
    document.getElementById('placeholder').style.display='none';
    img.style.display='block';img.src=imageUrl;
    document.getElementById('seedBadge').textContent='Seed: '+seed;
    document.getElementById('seedBadge').style.display='block';
    document.getElementById('imageActions').style.display='flex';
    addToHistory(imageUrl,prompt,seed,model);
    showToast('Image generated!','success');
  }catch(err){clearInterval(si);showToast(err.message,'error')}
  finally{isGenerating=false;btn.classList.remove('loading');btn.disabled=false;overlay.classList.remove('active')}
}

function downloadImage(){
  if(!currentImageUrl)return;
  if(currentImageUrl.startsWith('data:')){const a=document.createElement('a');a.href=currentImageUrl;a.download='flatai-'+(currentSeed||'image')+'.jpg';document.body.appendChild(a);a.click();document.body.removeChild(a)}
  else{const a=document.createElement('a');a.href=currentImageUrl;a.download='flatai-'+(currentSeed||'image')+'.jpg';a.target='_blank';document.body.appendChild(a);a.click();document.body.removeChild(a)}
  showToast('Downloading...','success');
}
function copySeed(){navigator.clipboard.writeText(String(currentSeed));showToast('Seed copied!','success')}

function addToHistory(url,prompt,seed,model){
  const isData=url&&url.startsWith('data:');
  history.unshift({url:isData?null:url,prompt,seed,model,time:Date.now()});
  if(history.length>8)history.pop();
  try{localStorage.setItem('flataiHist',JSON.stringify(history))}catch(e){}
  renderHistory();
}
function renderHistory(){
  const s=document.getElementById('historySection'),g=document.getElementById('historyGrid');
  if(!history.length){s.style.display='none';return}
  s.style.display='block';
  g.innerHTML=history.filter(i=>i.url).map((item,i)=>'<div class="history-item" onclick="loadHistory('+history.indexOf(item)+')" title="'+item.prompt.replace(/"/g,'&quot;')+'"><img src="'+item.url+'" alt="History" loading="lazy"></div>').join('');
}
function loadHistory(i){
  const item=history[i];if(!item||!item.url)return;
  const img=document.getElementById('generatedImg');img.src=item.url;img.style.display='block';
  document.getElementById('placeholder').style.display='none';
  document.getElementById('seedBadge').textContent='Seed: '+item.seed;document.getElementById('seedBadge').style.display='block';
  document.getElementById('imageActions').style.display='flex';
  document.getElementById('promptInput').value=item.prompt;
  currentSeed=item.seed;currentPrompt=item.prompt;currentImageUrl=item.url;
  window.scrollTo({top:0,behavior:'smooth'});
}

function showToast(msg,type=''){
  const t=document.getElementById('toast');t.className='toast '+type+' show';
  t.innerHTML='<i class="fas fa-'+(type==='success'?'check-circle':type==='error'?'exclamation-circle':'info-circle')+'"></i> '+msg;
  setTimeout(()=>t.classList.remove('show'),3500);
}

document.getElementById('promptInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();generateImage()}});
renderHistory();
</script>
</body>
</html>`;
