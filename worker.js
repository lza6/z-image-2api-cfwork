// =================================================================================
//  项目: z-image-2api (Cloudflare Worker 终极复刻版)
//  版本: 9.0.0 (代号: Reborn v4)
//  日期: 2025-11-30
//  描述: 1:1 复刻 v4.0 的解析内核，仅增加并发错峰控制和图片 403 修复。
// =================================================================================

const CONFIG = {
  // ⚠️ 请在 Cloudflare 环境变量中设置 API_MASTER_KEY，或者修改此处
  API_MASTER_KEY: "1", 
  
  // 上游 Gradio 服务地址
  UPSTREAM_ORIGIN: "https://mrfakename-z-image-turbo.hf.space",
  
  // 伪装身份 (通用)
  HEADERS: {
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
  },

  // 模型列表
  MODELS: [
    "z-image-turbo-2048",
    "z-image-turbo-1024",
    "z-image-quality"
  ],
  DEFAULT_MODEL: "z-image-turbo-2048",

  // 参数配置
  DEFAULT_WIDTH: 2048,
  DEFAULT_HEIGHT: 2048,
  DEFAULT_STEPS: 20,
  
  // --- 并发控制 ---
  DEFAULT_BATCH_SIZE: 2, 
  MAX_BATCH_SIZE: 2, 
  
  // 错峰延迟配置 (毫秒)
  DELAY_MIN: 1500, 
  DELAY_MAX: 3500  
};

export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);
    
    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. Web UI
    if (url.pathname === '/') return handleUI(request, apiKey);

    // 3. API 路由
    if (url.pathname.startsWith('/v1/')) return handleApi(request, apiKey);

    // 4. Gradio 代理
    if (url.pathname.startsWith('/proxy/gradio/')) return handleGradioProxy(request);

    // 5. 图片代理 (必须保留此修复，否则 403)
    if (url.pathname === '/proxy/image') return handleImageProxy(request);

    return createErrorResponse(`Not Found: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [核心业务: API 处理] ---

async function handleApi(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');
  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') return handleModelsRequest();
  if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, requestId);
  if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, requestId);

  return createErrorResponse('Not Found', 404, 'not_found');
}

// 辅助：生成随机延迟
function getRandomDelay() {
  return Math.floor(Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN + 1) + CONFIG.DELAY_MIN);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    if (!lastMsg) throw new Error("未找到用户消息");

    let prompt = lastMsg.content;
    let params = {
      prompt: prompt,
      width: CONFIG.DEFAULT_WIDTH,
      height: CONFIG.DEFAULT_HEIGHT,
      steps: CONFIG.DEFAULT_STEPS,
      seed: -1,
      n: CONFIG.DEFAULT_BATCH_SIZE
    };

    try {
      if (prompt.trim().startsWith('{')) {
        const parsed = JSON.parse(prompt);
        if (parsed.prompt) params = { ...params, ...parsed };
      }
    } catch (e) {}

    if (params.n > CONFIG.MAX_BATCH_SIZE) params.n = CONFIG.MAX_BATCH_SIZE;

    // ---------------------------------------------------------
    // 核心逻辑：错峰启动任务 (这是 v4.0 唯一缺少的逻辑)
    // ---------------------------------------------------------
    const tasks = [];
    let accumulatedDelay = 0;

    for (let i = 0; i < params.n; i++) {
        const currentSeed = params.seed === -1 ? -1 : params.seed + i;
        // 第一个立即执行，后续延迟
        const currentDelay = i === 0 ? 0 : getRandomDelay(); 
        accumulatedDelay += currentDelay;

        const taskPromise = (async (index, delay, seed) => {
            if (delay > 0) await sleep(delay); 
            return generateImage({ ...params, seed: seed }); // 调用 v4 内核
        })(i, accumulatedDelay, currentSeed);

        tasks.push(taskPromise);
    }

    // 流式响应
    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          await sendSSE(writer, encoder, requestId, `🚀 收到任务 (x${params.n})，正在排队...\n`);
          
          let logMsg = "";
          for(let i=0; i<params.n; i++) {
             if (i > 0) logMsg += `\n- 任务 ${i+1}: 延迟启动 (错峰排队)`;
          }
          if (logMsg) await sendSSE(writer, encoder, requestId, logMsg + "\n\n");

          const results = await Promise.all(tasks);
          
          let markdown = "";
          results.forEach((res, idx) => {
              const proxyUrl = getProxyImageUrl(res.url, request.url);
              markdown += `![Image ${idx+1}](${proxyUrl})\n`;
              markdown += `> Seed: \`${res.seed}\` | Time: \`${res.duration.toFixed(1)}s\`\n\n`;
          });
          
          await sendSSE(writer, encoder, requestId, markdown);
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
        } catch (e) {
          await sendSSE(writer, encoder, requestId, `\n\n❌ 任务失败: ${e.message}`);
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
        }
      })();

      return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
    } 
    // 非流式
    else {
      const results = await Promise.all(tasks);
      let markdown = "";
      results.forEach((res, idx) => {
          const proxyUrl = getProxyImageUrl(res.url, request.url);
          markdown += `![Image ${idx+1}](${proxyUrl})\n`;
          markdown += `*Seed: ${res.seed}*`;
      });

      return new Response(JSON.stringify({
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || CONFIG.DEFAULT_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: markdown }, finish_reason: "stop" }]
      }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    let width = CONFIG.DEFAULT_WIDTH;
    let height = CONFIG.DEFAULT_HEIGHT;
    let n = body.n || 1;
    if (n > CONFIG.MAX_BATCH_SIZE) n = CONFIG.MAX_BATCH_SIZE;

    if (body.size) {
      const parts = body.size.split('x');
      if (parts.length === 2) { width = parseInt(parts[0]); height = parseInt(parts[1]); }
    }

    const tasks = [];
    let accumulatedDelay = 0;

    for (let i = 0; i < n; i++) {
        const currentDelay = i === 0 ? 0 : getRandomDelay();
        accumulatedDelay += currentDelay;
        
        const taskPromise = (async (delay) => {
            if (delay > 0) await sleep(delay);
            return generateImage({
                prompt: body.prompt,
                width, height,
                steps: CONFIG.DEFAULT_STEPS,
                seed: -1
            });
        })(accumulatedDelay);
        
        tasks.push(taskPromise);
    }

    const results = await Promise.all(tasks);
    const data = results.map(res => ({ 
        url: getProxyImageUrl(res.url, request.url),
        revised_prompt: `Seed: ${res.seed}`
    }));

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: data
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

// --- [核心逻辑: Gradio 交互 (1:1 复刻 v4.0)] ---
// 这里的逻辑完全照搬 v4.0，不做任何“优化”，因为它最稳定
async function generateImage(params) {
  const sessionHash = Math.random().toString(36).substring(2, 12);
  const seed = params.seed === -1 ? Math.floor(Math.random() * 1000000000) : params.seed;
  
  // 1. Join Queue
  const joinUrl = `${CONFIG.UPSTREAM_ORIGIN}/gradio_api/queue/join?`;
  const joinRes = await fetch(joinUrl, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "User-Agent": CONFIG.HEADERS["user-agent"]
    },
    body: JSON.stringify({
      data: [params.prompt, params.width, params.height, params.steps, seed, false],
      fn_index: 1,
      trigger_id: 16,
      session_hash: sessionHash
    })
  });

  if (!joinRes.ok) throw new Error(`Join failed: ${joinRes.status}`);

  // 2. Listen to Stream
  const dataUrl = `${CONFIG.UPSTREAM_ORIGIN}/gradio_api/queue/data?session_hash=${sessionHash}`;
  const dataRes = await fetch(dataUrl, {
    headers: { 
      "Accept": "text/event-stream",
      "User-Agent": CONFIG.HEADERS["user-agent"]
    }
  });

  if (!dataRes.ok) throw new Error(`Stream failed: ${dataRes.status}`);

  const reader = dataRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // v4.0 原始循环逻辑
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    
    // 只要 buffer 里有 process_completed，就暴力解析
    if (buffer.includes('process_completed')) {
        const lines = buffer.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const jsonStr = line.slice(6);
                    const msg = JSON.parse(jsonStr);
                    
                    if (msg.msg === 'process_completed' && msg.success) {
                        return { 
                            url: msg.output.data[0].url, 
                            seed: seed, 
                            duration: msg.output.duration || 0 
                        };
                    }
                } catch (e) {
                    // 忽略解析错误，继续读
                }
            }
        }
    }
  }
  
  // 如果循环结束还没返回，尝试最后一次解析 buffer
  if (buffer.includes('process_completed')) {
      const lines = buffer.split('\n');
      for (const line of lines) {
          if (line.startsWith('data: ')) {
              try {
                  const msg = JSON.parse(line.slice(6));
                  if (msg.msg === 'process_completed' && msg.success) {
                      return { url: msg.output.data[0].url, seed: seed, duration: msg.output.duration || 0 };
                  }
              } catch(e) {}
          }
      }
  }

  throw new Error("Stream ended without result");
}

// --- [代理逻辑] ---

async function handleGradioProxy(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/proxy/gradio', '/gradio_api');
  const targetUrl = `${CONFIG.UPSTREAM_ORIGIN}${path}${url.search}`;

  const newHeaders = new Headers(request.headers);
  newHeaders.set('Origin', CONFIG.UPSTREAM_ORIGIN);
  newHeaders.set('Referer', `${CONFIG.UPSTREAM_ORIGIN}/`);
  newHeaders.set('Host', new URL(CONFIG.UPSTREAM_ORIGIN).host);
  
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: newHeaders,
    body: request.body
  });

  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  return newResponse;
}

// --- [关键修复: 图片代理 (v6.2 逻辑)] ---
// 必须保留这个，否则图片 403
async function handleImageProxy(request) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url'); 
  if (!targetUrl) return new Response("Missing URL", { status: 400 });

  try {
    const headers = new Headers();
    headers.set("User-Agent", CONFIG.HEADERS["user-agent"]);
    headers.set("Referer", `${CONFIG.UPSTREAM_ORIGIN}/`); 
    // 移除 Origin 和 Sec-Fetch-*
    
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: headers,
      redirect: "follow"
    });
    
    if (!response.ok) {
        return new Response(`Image Proxy Failed: ${response.status}`, { status: response.status });
    }

    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Cache-Control', 'public, max-age=31536000');
    newResponse.headers.delete("content-security-policy"); 
    newResponse.headers.delete("x-frame-options");
    
    return newResponse;
  } catch (e) {
    return new Response("Image Proxy Error", { status: 500 });
  }
}

// --- [辅助函数] ---

function getProxyImageUrl(originalUrl, workerUrl) {
  if (!originalUrl) return null;
  const workerOrigin = new URL(workerUrl).origin;
  return `${workerOrigin}/proxy/image?url=${encodeURIComponent(originalUrl)}`;
}

function verifyAuth(req, apiKey) {
  if (apiKey === "1") return true;
  const auth = req.headers.get('Authorization');
  return auth === `Bearer ${apiKey}`;
}

async function sendSSE(writer, encoder, id, content) {
  const chunk = {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
    model: CONFIG.DEFAULT_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }]
  };
  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

function handleModelsRequest() {
  return new Response(JSON.stringify({
    object: 'list',
    data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'z-image' }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [Web UI 界面] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const modelOptions = CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Z-Image-Turbo 驾驶舱</title>
<style>
:root { --bg:#0a0a0a; --panel:#141414; --border:#333; --primary:#00e5ff; --text:#ededed; --success:#00c853; --error:#ff1744; }
body { font-family:'Segoe UI',sans-serif; background:var(--bg); color:var(--text); margin:0; height:100vh; display:flex; overflow:hidden; }
.sidebar { width:360px; background:var(--panel); border-right:1px solid var(--border); padding:20px; display:flex; flex-direction:column; gap:15px; overflow-y:auto; flex-shrink:0; }
.main { flex:1; display:flex; flex-direction:column; padding:20px; gap:20px; overflow:hidden; position:relative; }
.box { background:#1f1f1f; padding:15px; border-radius:8px; border:1px solid var(--border); }
.label { font-size:12px; color:#888; margin-bottom:6px; display:block; font-weight:600; }
input,select,textarea { width:100%; background:#2a2a2a; border:1px solid #444; color:#fff; padding:10px; border-radius:6px; box-sizing:border-box; font-family:inherit; }
input:focus,textarea:focus { border-color:var(--primary); outline:none; }
button { width:100%; padding:12px; background:var(--primary); border:none; border-radius:6px; font-weight:bold; cursor:pointer; color:#000; transition:0.2s; }
button:hover { filter:brightness(1.1); }
button:disabled { background:#444; color:#888; cursor:not-allowed; }
.param-row { display:flex; gap:10px; }
.param-row > div { flex:1; }
.gallery-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:15px; margin-top:15px; overflow-y:auto; flex:1; padding-bottom:200px; }
.gallery-card { background:#1a1a1a; border:1px solid #333; border-radius:8px; overflow:hidden; display:flex; flex-direction:column; transition:0.2s; position:relative; }
.gallery-card:hover { border-color:var(--primary); transform:translateY(-2px); }
.card-img-box { aspect-ratio:1; background:#000; position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.card-img-box img { width:100%; height:100%; object-fit:contain; cursor:pointer; display:none; }
.card-footer { padding:10px; display:flex; justify-content:space-between; align-items:center; background:#222; border-top:1px solid #333; height:30px; }
.card-status { font-size:11px; color:#888; }
.card-btn { background:none; border:1px solid #444; color:#ccc; padding:4px 8px; font-size:11px; border-radius:4px; cursor:pointer; text-decoration:none; display:none; }
.card-btn:hover { background:#333; color:#fff; border-color:#666; }
.debug-panel { position:absolute; bottom:0; left:0; right:0; height:200px; background:#000; border-top:1px solid var(--border); display:flex; flex-direction:column; font-family:'Consolas', monospace; font-size:12px; z-index:100; transition: height 0.3s; }
.debug-header { padding:5px 10px; background:#222; border-bottom:1px solid #333; display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none; }
.debug-title { color:var(--primary); font-weight:bold; }
.debug-content { flex:1; overflow-y:auto; padding:10px; color:#0f0; white-space:pre-wrap; word-break:break-all; }
.debug-entry { margin-bottom:4px; border-bottom:1px solid #111; padding-bottom:2px; }
.debug-time { color:#666; margin-right:8px; }
.spinner { width:20px; height:20px; border:2px solid #444; border-top-color:var(--primary); border-radius:50%; animation:spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.code-block { font-family: monospace; font-size: 12px; color: var(--primary); background: #111; padding: 8px; border-radius: 4px; cursor: pointer; word-break:break-all; }
</style>
</head>
<body>
<div class="sidebar">
    <h2 style="margin:0;color:var(--primary)">⚡ Z-Image-Turbo <span style="font-size:12px;color:#666">v9.0</span></h2>
    <div class="box">
        <span class="label">API 密钥</span>
        <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        <span class="label" style="margin-top:10px">API 地址</span>
        <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
    </div>
    <div class="box">
        <span class="label">并发数 (Batch Size, Max: ${CONFIG.MAX_BATCH_SIZE})</span>
        <input type="range" id="batchSize" min="1" max="${CONFIG.MAX_BATCH_SIZE}" value="${CONFIG.DEFAULT_BATCH_SIZE}" oninput="document.getElementById('batchVal').innerText = this.value">
        <div style="text-align:right;font-size:12px;color:#888" id="batchVal">${CONFIG.DEFAULT_BATCH_SIZE}</div>
    </div>
    <div class="box">
        <span class="label">模型</span>
        <select id="model">${modelOptions}</select>
        <div class="param-row">
            <div><span class="label">宽度</span><input type="number" id="width" value="${CONFIG.DEFAULT_WIDTH}" step="64"></div>
            <div><span class="label">高度</span><input type="number" id="height" value="${CONFIG.DEFAULT_HEIGHT}" step="64"></div>
        </div>
        <div class="param-row">
            <div><span class="label">步数</span><input type="number" id="steps" value="${CONFIG.DEFAULT_STEPS}" min="1" max="50"></div>
            <div><span class="label">种子 (-1随机)</span><input type="number" id="seed" value="-1"></div>
        </div>
    </div>
    <div class="box">
        <span class="label">提示词</span>
        <textarea id="prompt" rows="5" placeholder="描述画面..."></textarea>
        <button id="btnGen" onclick="startBatchGeneration()">🚀 立即生成</button>
    </div>
</div>
<main class="main">
    <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:10px">
        <h3 style="margin:0">🖼️ 实时画廊</h3>
        <button onclick="document.getElementById('gallery').innerHTML=''" style="width:auto;padding:5px 10px;font-size:12px;background:#333">清空</button>
    </div>
    <div class="gallery-grid" id="gallery"></div>
    <div class="debug-panel" id="debugPanel">
        <div class="debug-header" onclick="toggleDebug()">
            <span class="debug-title">>_ 交互日志</span>
            <span id="debugToggle">▼</span>
        </div>
        <div class="debug-content" id="debugContent">
            <div class="debug-entry"><span class="debug-time">SYSTEM</span> Ready.</div>
        </div>
    </div>
</main>
<script>
const PROXY_JOIN = "${origin}/proxy/gradio/queue/join?";
const PROXY_DATA = "${origin}/proxy/gradio/queue/data";
const PROXY_IMAGE_BASE = "${origin}/proxy/image?url=";
let isDebugOpen = true;

function copy(text) { navigator.clipboard.writeText(text); alert('已复制'); }
function toggleDebug() {
    const panel = document.getElementById('debugPanel');
    const toggle = document.getElementById('debugToggle');
    if (isDebugOpen) { panel.style.height = '30px'; toggle.innerText = '▲'; } 
    else { panel.style.height = '200px'; toggle.innerText = '▼'; }
    isDebugOpen = !isDebugOpen;
}
function log(msg, type='INFO') {
    const c = document.getElementById('debugContent');
    const d = document.createElement('div');
    d.className = 'debug-entry';
    d.innerHTML = \`<span class="debug-time">\${new Date().toLocaleTimeString()}</span><span style="color:\${type==='ERROR'?'#f00':type==='SUCCESS'?'#0f0':type==='HEARTBEAT'?'#555':'#aaa'}">[\${type}] \${msg}</span>\`;
    c.appendChild(d);
    c.scrollTop = c.scrollHeight;
}

function createCard(id, prompt) {
    const div = document.createElement('div');
    div.className = 'gallery-card';
    div.id = 'card-' + id;
    div.innerHTML = \`
        <div class="card-img-box">
            <div class="spinner" id="spin-\${id}"></div>
            <img id="img-\${id}" onclick="window.open(this.src)">
        </div>
        <div class="card-footer">
            <span class="card-status" id="status-\${id}">排队中...</span>
            <a class="card-btn" id="dl-\${id}" target="_blank">下载</a>
        </div>
        <div style="padding:0 10px 10px;font-size:10px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${prompt}</div>
    \`;
    document.getElementById('gallery').prepend(div);
    return div;
}

async function startBatchGeneration() {
    const prompt = document.getElementById('prompt').value.trim();
    if (!prompt) return alert("请输入提示词");
    
    const batchSize = parseInt(document.getElementById('batchSize').value);
    const width = parseInt(document.getElementById('width').value);
    const height = parseInt(document.getElementById('height').value);
    const steps = parseInt(document.getElementById('steps').value);
    let baseSeed = parseInt(document.getElementById('seed').value);
    
    const btn = document.getElementById('btnGen');
    btn.disabled = true;
    btn.innerText = \`正在提交 \${batchSize} 个任务...\`;

    for (let i = 0; i < batchSize; i++) {
        const seed = baseSeed === -1 ? Math.floor(Math.random() * 1000000000) : baseSeed + i;
        const taskId = Math.random().toString(36).substring(7);
        createCard(taskId, prompt);
        
        const delay = i === 0 ? 0 : Math.floor(Math.random() * 2000 + 1500);
        if (delay > 0) {
             log(\`Task \${taskId}: Waiting \${delay}ms before start...\`, 'INFO');
             await new Promise(r => setTimeout(r, delay));
        }

        runSingleTask(taskId, prompt, width, height, steps, seed);
    }

    btn.disabled = false;
    btn.innerText = "🚀 立即生成";
}

async function runSingleTask(taskId, prompt, width, height, steps, seed) {
    const sessionHash = Math.random().toString(36).substring(2, 12);
    log(\`Task \${taskId}: Starting (Seed: \${seed})...\`);
    
    try {
        const joinRes = await fetch(PROXY_JOIN, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                data: [prompt, width, height, steps, seed, false],
                fn_index: 1,
                trigger_id: 16,
                session_hash: sessionHash
            })
        });
        
        if (!joinRes.ok) throw new Error("Join failed: " + joinRes.status);
        document.getElementById(\`status-\${taskId}\`).innerText = "连接流...";

        const dataUrl = \`\${PROXY_DATA}?session_hash=\${sessionHash}\`;
        const response = await fetch(dataUrl, {
            headers: { "Accept": "text/event-stream" }
        });
        
        if (!response.ok) throw new Error("Stream failed: " + response.status);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            
            if (buffer.includes('process_completed')) {
                const lines = buffer.split('\\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const jsonStr = line.slice(6);
                            const msg = JSON.parse(jsonStr);
                            
                            if (msg.msg === 'process_starts') {
                                document.getElementById(\`status-\${taskId}\`).innerText = "生成中...";
                            } else if (msg.msg === 'process_completed') {
                                if (msg.success) {
                                    let rawUrl = msg.output.data[0].url;
                                    const fullUrl = PROXY_IMAGE_BASE + encodeURIComponent(rawUrl);
                                    
                                    const img = document.getElementById(\`img-\${taskId}\`);
                                    const spin = document.getElementById(\`spin-\${taskId}\`);
                                    const status = document.getElementById(\`status-\${taskId}\`);
                                    const dl = document.getElementById(\`dl-\${taskId}\`);
                                    
                                    img.src = fullUrl;
                                    img.style.display = 'block';
                                    spin.style.display = 'none';
                                    status.innerText = '完成';
                                    status.style.color = 'var(--success)';
                                    dl.href = fullUrl;
                                    dl.download = \`z-image-\${taskId}.png\`;
                                    dl.style.display = 'inline-block';
                                    
                                    log(\`Task \${taskId}: Success\`, 'SUCCESS');
                                    return; 
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        }
    } catch (e) {
        log(\`Task \${taskId}: Error - \${e.message}\`, 'ERROR');
        const status = document.getElementById(\`status-\${taskId}\`);
        const spin = document.getElementById(\`spin-\${taskId}\`);
        if(status) { status.innerText = '失败'; status.style.color = 'var(--error)'; }
        if(spin) spin.style.display = 'none';
    }
}
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
