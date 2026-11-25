// 나만의 라디오 워커
// GET /mbc?ch=sfm|mfm|chm   MBC는 브라우저가 방송 주소(토큰 붙은 m3u8)를 직접 받아가지 못하게 막아 두어서 대신 받아 줌.
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

// 받아쓰기: 1) Deepgram Nova-3 (영어 전용, 1~3초로 빠르고 꾸준함)
// 2) 안 되면 Whisper large-v3-turbo (요즘 Cloudflare 쪽이 가끔 고장·2~20초로 들쭉날쭉) 3) 마지막으로 기본 whisper
// 앱은 20초면 포기하므로 단계마다 시간 제한을 둠
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout ' + ms + 'ms')), ms))]);
async function whisper(env, audio, prompt, skip) {
  const errs = [], fail = (m, e) => errs.push(m + ': ' + String(e && e.message || e).slice(0, 80));
  if (skip !== 'nova') try {
    const o = await within(env.AI.run('@cf/deepgram/nova-3', { audio: { body: new Blob([audio]).stream(), contentType: 'audio/wav' }, punctuate: true, smart_format: true, language: 'en' }), 7000);
    const alt = o?.results?.channels?.[0]?.alternatives?.[0];
    if (alt) return { m: 'nova-3', text: String(alt.transcript || ''), words: (alt.words || []).map(w => ({ word: w.punctuated_word || w.word, start: w.start, end: w.end })) };
    fail('nova-3', 'no result');
  } catch (e) { fail('nova-3', e); }
  if (skip !== 'turbo') try {
    const input = { audio: b64(audio), language: 'en', task: 'transcribe', vad_filter: true };
    if (prompt) input.initial_prompt = prompt;
    const o = await within(env.AI.run('@cf/openai/whisper-large-v3-turbo', input), 8000);
    return Object.assign(o || {}, { m: 'turbo' });
  } catch (e) { fail('turbo', e); }
  try {
    const out = await env.AI.run('@cf/openai/whisper', { audio: [...audio] });
    // 이 모델은 언어를 정할 수 없어 조용할 때 다른 언어 헛소리("Субтитры…")를 냄 → 영어가 아니면 버림
    const t = String(out?.text || '');
    if (/[^\u0000-\u00bf\u2000-\u206f\s]/.test(t) || /subtitles|subtitle by|amara\.org|thanks for watching/i.test(t)) return { text: '', words: [], m: 'whisper' };
    return Object.assign(out || {}, { m: 'whisper' });
  } catch (e) { fail('whisper', e); }
  throw new Error(errs.join(' | '));
}

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
        return json({ error: String(e && e.message || e).slice(0, 200) }, 502);
      }
    }
    // POST /transcribe?prompt=...  앱이 지금 재생 중인 소리 3초 조각(바이트)을 보내면 받아쓴 글을 돌려줌.
    // prompt: 바로 앞 자막 (문장이 조각 사이에서 끊겨도 이어지게)
    if (url.pathname === '/transcribe') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
      try {
        const audio = new Uint8Array(await req.arrayBuffer());
        if (audio.length < 2000) return json({ text: '' });
        if (audio.length > 400000) return json({ error: 'too long' }, 413);
        const out = await whisper(env, audio, (url.searchParams.get('prompt') || '').slice(-300), url.searchParams.get('skip'));
        // 단어마다 이 조각 안에서 몇 초에 말했는지 [단어, 시작, 끝] → 앱이 지금 말하는 단어를 짚어 줌
        const res = { text: String(out?.text || '').trim(), words: wordTimes(out), m: out?.m };
        if (url.searchParams.get('debug') === '1') res.raw = JSON.stringify(out).slice(0, 1500);
        return json(res);
      } catch (e) {
        return json({ error: String(e && e.message || e).slice(0, 200) }, 502);
      }
    }
    // GET /translate?text=...  영어 한 문장을 한국어로
    if (url.pathname === '/translate') {
      const text = (url.searchParams.get('text') || '').slice(0, 600);
      if (!text) return json({ ko: '' });
      try {
        const tr = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: 'english', target_lang: 'korean' });
        return json({ ko: String(tr?.translated_text || '').trim() });
      } catch (e) {
        return json({ error: String(e && e.message || e).slice(0, 200) }, 502);
      }
    }
    if (url.pathname === '/ping') return new Response('ok', { headers: CORS });
    return new Response('not found', { status: 404, headers: CORS });
  }
};
