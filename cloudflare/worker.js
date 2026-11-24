// 나만의 라디오 - MBC 방송 주소 풀기.
// MBC는 브라우저가 방송 주소(토큰 붙은 m3u8)를 직접 받아가지 못하게 막아 두어서,
// 이 워커가 대신 받아서 CORS 헤더를 붙여 돌려준다.  GET /mbc?ch=sfm|mfm|chm
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
export default {
  async fetch(req) {
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
    if (url.pathname === '/ping') return new Response('ok', { headers: CORS });
    return new Response('not found', { status: 404, headers: CORS });
  }
};
