// 나만의 라디오 워커
// GET /mbc?ch=sfm|mfm|chm   MBC는 브라우저가 방송 주소(토큰 붙은 m3u8)를 직접 받아가지 못하게 막아 두어서 대신 받아 줌.
// GET /stream?id=bbcws      자막 방송 소리를 CORS 붙여 그대로 이어 줌
// GET /caption?id=bbcws[&ko=1]  영어 뉴스 방송의 지금 소리를 몇 초 받아 Whisper(Workers AI)로 받아쓴 글을 돌려줌.
//                              ko=1이면 한국어 번역도 함께. 응답: {"text": "...", "ko": "..."}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

// 자막을 만들 수 있는 방송 (주소를 앱에서 받지 않고 여기 고정: 아무 주소나 받아쓰는 통로가 되지 않게)
const CAPTION = {
  bbcws: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service',
  npr: 'https://npr-ice.streamguys1.com/live.mp3',
  cnn: 'https://tunein.cdnstream1.com/2868_96.mp3',
  lbc: 'https://media-ice.musicradio.com/LBCUKMP3',
  times: 'https://timesradio.wireless.radio/stream',
  wnyc: 'https://fm939.wnyc.org/wnycfm',
};

// 생방송 스트림에서 약 secs초 분량(또는 maxBytes)만 읽고 끊음
async function grab(url, secs, maxBytes) {
  const ctrl = new AbortController();
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Icy-MetaData': '0' }, signal: ctrl.signal });
  if (!r.ok || !r.body) throw new Error('stream ' + r.status);
  const reader = r.body.getReader(), parts = [], end = Date.now() + secs * 1000;
  let n = 0;
  while (n < maxBytes && Date.now() < end) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
  }
  try { ctrl.abort(); } catch (e) {}
  const buf = new Uint8Array(n); let o = 0;
  for (const p of parts) { buf.set(p.subarray(0, Math.min(p.length, n - o)), o); o += p.length; if (o >= n) break; }
  return buf;
}

// Whisper 결과에서 [단어, 시작초, 끝초] 목록 (조각 맨 앞이 0초)
function wordTimes(out) {
  const words = [], add = w => { const t = String(w.word || '').trim(); if (t) words.push([t, Math.round(w.start * 100) / 100, Math.round(w.end * 100) / 100]); };
  for (const sg of out?.segments || []) for (const w of sg.words || []) add(w);
  if (!words.length) for (const w of out?.words || []) add(w);
  return words;
}

// 받아쓰기
// 0) Groq: 같은 Whisper large-v3-turbo를 무료 계정으로 하루 약 2,000번·8시간까지. 키(GROQ_KEY 비밀값)가 있을 때만.
//    한 번에 최소 10초로 계산되므로 앱이 소리를 10초 넘게 모아 보냄. 한도에 걸리면 알려 준 시간 동안 건너뜀
// 그다음 Cloudflare Workers AI (무료 사용량: 하루 10,000 뉴런, 한국 시간 오전 9시에 새로 채워짐)
// 1) Whisper large-v3-turbo: 1분에 약 47뉴런 → 하루 약 3시간 반. 가끔 늦거나 고장 나서 10초 제한
// 2) 기본 whisper: 1분에 약 41뉴런, 정확도는 조금 낮음
// (Deepgram Nova-3는 1분에 약 473뉴런(10배)이라 뺌: 시간 초과로 넘어가도 앞 모델 값은 그대로 나가서,
//  turbo가 늦는 날엔 세 모델 값이 한꺼번에 나가 하루 한도가 금방 바닥났음)
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout ' + ms + 'ms')), ms))]);
const isQuota = e => /4006|daily free allocation|^quota$/i.test(String(e && e.message || e));
let groqOff = 0;
async function groq(env, audio, prompt) {
  const wav = audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46;   // 'RIF'F
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: wav ? 'audio/wav' : 'audio/mpeg' }), wav ? 'a.wav' : 'a.mp3');
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', 'en');
  fd.append('temperature', '0');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  if (prompt) fd.append('prompt', prompt);
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.GROQ_KEY }, body: fd });
  if (r.status === 429) {   // 한도: 알려 준 시간(초)만큼 쉬고 그동안 Cloudflare로
    groqOff = Date.now() + Math.min(Math.max(Number(r.headers.get('retry-after')) || 60, 20), 6 * 3600) * 1000;
    throw new Error('groq 429');
  }
  if (r.status === 401 || r.status === 403) { groqOff = Date.now() + 3600e3; throw new Error('groq key ' + r.status); }
  if (!r.ok) throw new Error('groq ' + r.status + ' ' + (await r.text()).slice(0, 80));
  const o = await r.json();
  // 말이 없는 구간(Whisper가 '말 없음'이라 본 곳)과 같은 말만 되풀이한 구간("A A A A")의 헛소리는 버림
  const bad = (o.segments || []).filter(g => (g.no_speech_prob > 0.6 && g.avg_logprob < -1) || g.compression_ratio > 2.4);
  let words = (o.words || []).filter(w => !bad.some(g => w.start >= g.start - 0.05 && w.start < g.end));
  const segs = o.segments || [], text = segs.length ? segs.filter(g => !bad.includes(g)).map(g => String(g.text).trim()).join(' ') : o.text;
  // 단어 목록에는 문장부호가 빠져 있을 수 있음 → 글에서 같은 단어를 찾아 부호째로 바꿈 (자막을 문장·쉼표에서 끊는 데 씀)
  const toks = String(text || '').trim().split(/\s+/), norm = x => String(x).toLowerCase().replace(/[^a-z0-9']/g, '');
  let i = 0;
  words = words.map(w => {
    const n = norm(w.word);
    for (let k = i; k < Math.min(toks.length, i + 4); k++) if (n && norm(toks[k]) === n) { i = k + 1; return { word: toks[k], start: w.start, end: w.end }; }
    return w;
  });
  return { text: String(text || '').trim(), words };
}
async function whisper(env, audio, prompt, skip) {
  const errs = [], fail = (m, e) => {
    if (isQuota(e)) throw new Error('quota', { cause: String(e && e.message || e) });   // 오늘 무료 사용량을 다 씀: 다른 모델도 똑같이 막힘
    errs.push(m + ': ' + String(e && e.message || e).slice(0, 80));
  };
  if (env.GROQ_KEY && Date.now() > groqOff && skip !== 'groq') try {
    return Object.assign(await within(groq(env, audio, prompt), 8000), { m: 'groq' });
  } catch (e) { errs.push('groq: ' + String(e && e.message || e).slice(0, 80)); }
  if (skip !== 'turbo') try {
    const input = { audio: b64(audio), language: 'en', task: 'transcribe', vad_filter: true };
    if (prompt) input.initial_prompt = prompt;
    const o = await within(env.AI.run('@cf/openai/whisper-large-v3-turbo', input), 10000);
    return Object.assign(o || {}, { m: 'turbo' });
  } catch (e) { fail('turbo', e); }
  try {
    const out = await within(env.AI.run('@cf/openai/whisper', { audio: [...audio] }), 8000);
    // 이 모델은 언어를 정할 수 없어 조용할 때 다른 언어 헛소리("Субтитры…")를 냄 → 영어가 아니면 버림
    const t = String(out?.text || '');
    if (/[^\u0000-\u00bf\u2000-\u206f\s]/.test(t) || /subtitles|subtitle by|amara\.org|thanks for watching/i.test(t)) return { text: '', words: [], m: 'whisper' };
    return Object.assign(out || {}, { m: 'whisper' });
  } catch (e) { fail('whisper', e); }
  throw new Error(errs.join(' | '));
}
// 오류 응답: 오늘 무료 사용량을 다 쓴 경우는 앱이 알아보게 'quota' (429)
const errJson = e => isQuota(e) ? json({ error: 'quota', detail: String(e && e.cause || '').slice(0, 160) }, 429) : json({ error: String(e && e.message || e).slice(0, 200) }, 502);

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/mbc') {
      const ch = url.searchParams.get('ch') || '';
      if (!/^(sfm|mfm|chm)$/.test(ch)) return new Response('bad channel', { status: 400, headers: CORS });
      const r = await fetch(`https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=${ch}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mini.imbc.com/' } });
      const t = (await r.text()).trim().split(/\s+/)[0] || '';
      if (!r.ok || !/^https:\/\/\S+\.m3u8/.test(t)) return new Response('mbc error', { status: 502, headers: CORS });
      return new Response(t, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname === '/caption') {
      const src = CAPTION[url.searchParams.get('id') || ''];
      if (!src) return json({ error: 'no captions for this station' }, 400);
      try {
        const audio = await grab(src, 6, 100000);    // PC 스피커일 때만 씀: ~6초
        if (audio.length < 8000) return json({ text: '' });
        const out = await whisper(env, audio);
        const text = String(out?.text || '').trim();
        const res = { text, words: wordTimes(out) };
        if (url.searchParams.get('ko') === '1' && text) {
          const tr = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: 'english', target_lang: 'korean' });
          res.ko = String(tr?.translated_text || '').trim();
        }
        return json(res);
      } catch (e) {
        return errJson(e);
      }
    }
    // POST /transcribe?prompt=...  앱이 곧 재생할 소리 조각(4~20초 WAV)을 보내면 받아쓴 글을 돌려줌.
    // prompt: 바로 앞 자막 (문장이 조각 사이에서 끊겨도 이어지게)
    if (url.pathname === '/transcribe') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
      try {
        const audio = new Uint8Array(await req.arrayBuffer());
        if (audio.length < 2000) return json({ text: '' });
        if (audio.length > 900000) return json({ error: 'too long' }, 413);
        const out = await whisper(env, audio, (url.searchParams.get('prompt') || '').slice(-300), url.searchParams.get('skip'));
        // 단어마다 이 조각 안에서 몇 초에 말했는지 [단어, 시작, 끝] → 앱이 지금 말하는 단어를 짚어 줌
        const res = { text: String(out?.text || '').trim(), words: wordTimes(out), m: out?.m };
        if (url.searchParams.get('debug') === '1') res.raw = JSON.stringify(out).slice(0, 1500);
        return json(res);
      } catch (e) {
        return errJson(e);
      }
    }
    // GET /stream?id=npr  자막 방송의 소리를 그대로 이어 줌 (방송 서버가 가끔 브라우저 접근(CORS)을 막을 때 앱이 대신 씀)
    if (url.pathname === '/stream') {
      const src = CAPTION[url.searchParams.get('id') || ''];
      if (!src) return new Response('no such station', { status: 400, headers: CORS });
      const r = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0', 'Icy-MetaData': '0' } });
      if (!r.ok || !r.body) return new Response('stream ' + r.status, { status: 502, headers: CORS });
      return new Response(r.body, { headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'audio/mpeg' } });
    }
    if (url.pathname === '/stt') return json({ groq: !!env.GROQ_KEY, groqOff: Math.max(0, Math.round((groqOff - Date.now()) / 1000)) });
    // GET /translate?text=...  영어 한 문장을 한국어로
    if (url.pathname === '/translate') {
      const text = (url.searchParams.get('text') || '').slice(0, 600);
      if (!text) return json({ ko: '' });
      try {
        const tr = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: 'english', target_lang: 'korean' });
        return json({ ko: String(tr?.translated_text || '').trim() });
      } catch (e) {
        return errJson(e);
      }
    }
    // PC 스피커 자막 우편함: PC 스피커 창이 자기가 낼 소리를 받아써서 단어마다 '몇 시에 들리는지'를 넣고(POST),
    // 폰이 읽어 감(GET). k = 연결 코드. 응답의 now = 이 서버 시계(ms): 두 기기가 같은 시계로 맞춤
    if (url.pathname === '/pccap') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
      const k = url.searchParams.get('k') || '';
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(k)) return json({ error: 'bad key' }, 400);
      const stub = env.CAPHUB.get(env.CAPHUB.idFromName(k));
      return stub.fetch(req);
    }
    if (url.pathname === '/ping') return new Response('ok', { headers: CORS });
    return new Response('not found', { status: 404, headers: CORS });
  }
};

// 연결 코드 하나에 하나: 최근 3분 자막 조각을 메모리에 둠 (저장하지 않음)
export class CapHub {
  constructor(state) { this.segs = []; this.ch = ''; }
  async fetch(req) {
    const url = new URL(req.url), now = Date.now();
    if (req.method === 'POST') {
      let b; try { b = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const ch = String(b.ch || '').slice(0, 20);
      if (ch !== this.ch) { this.ch = ch; this.segs = []; }   // 채널이 바뀌면 비움
      if (b.reset) { this.segs = []; return json({ ok: 1, now }); }
      const s = Number(b.s), e = Number(b.e);
      if (isFinite(s) && isFinite(e) && b.text) {
        this.segs.push({ id: now + Math.random(), at: now, s, e, text: String(b.text).slice(0, 2000), words: Array.isArray(b.words) ? b.words.slice(0, 400) : [] });
        this.segs = this.segs.filter(g => g.e > now - 180000).slice(-40);
      }
      return json({ ok: 1, now });
    }
    const after = Number(url.searchParams.get('after')) || 0;
    return json({ now, ch: this.ch, segs: this.segs.filter(g => g.at > after) });
  }
}
