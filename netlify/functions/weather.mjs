// 날씨(기상청) + 미세먼지(에어코리아)를 대신 호출하는 Netlify Function
// 인증키: Netlify 환경변수 DATA_GO_KR_KEY (공공데이터포털 '일반 인증키(Decoding)')
// 공공데이터포털에서 아래 두 서비스를 각각 '활용신청' 해야 같은 키로 둘 다 쓸 수 있습니다.
//   - 기상청_단기예보 ((구)_동네예보) 조회서비스
//   - 한국환경공단_에어코리아_대기오염정보

// ── 학교 위치 / 측정소 설정 ─────────────────────────────────────
const LAT = Number(process.env.SCHOOL_LAT || 33.456);   // 물메초 (제주시 애월읍 수산리) 근처
const LON = Number(process.env.SCHOOL_LON || 126.392);
// 가까운 측정소 우선순위 (앞에서부터 데이터가 있는 곳을 사용)
const STATIONS = (process.env.AIR_STATIONS || "애월읍,노형동,연동,이도동").split(",").map(s => s.trim());
const SCHOOL_HOURS = [9, 15];   // 등교~하교 시간대 (강수 판단용)
// ────────────────────────────────────────────────────────────────

const KMA = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/";
const AIR = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty";

// 위경도 → 기상청 격자(nx, ny) 변환 (기상청 공식 LCC 변환식)
function toGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30, SLAT2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136;
  const D = Math.PI / 180, re = RE / GRID;
  const s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(s1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * D * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// Netlify 서버는 UTC 시간이므로 한국 시간(KST)으로 계산
function kstParts(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600e3);
  const p = n => String(n).padStart(2, "0");
  return { ymd: d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()), h: d.getUTCHours(), m: d.getUTCMinutes() };
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (text.trim().startsWith("<")) {        // 공공데이터포털은 키 오류 등을 XML로 돌려줌
    const msg = (text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/) || text.match(/<resultMsg>(.*?)<\/resultMsg>/) || [])[1];
    throw new Error(msg === "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" ? "인증키가 등록되지 않았거나 활용신청이 안 되어 있어요" : (msg || "응답 형식 오류"));
  }
  const json = JSON.parse(text);
  const code = json?.response?.header?.resultCode;
  if (code && code !== "00") {
    if (code === "03") return [];            // NO_DATA
    throw new Error(json.response.header.resultMsg);
  }
  const items = json?.response?.body?.items;
  return Array.isArray(items) ? items : (items?.item || []);
}

function kmaUrl(op, base_date, base_time, grid, rows) {
  const q = new URLSearchParams({
    serviceKey: process.env.DATA_GO_KR_KEY || "", pageNo: "1", numOfRows: String(rows),
    dataType: "JSON", base_date, base_time, nx: String(grid.nx), ny: String(grid.ny),
  });
  return KMA + op + "?" + q;
}

// 초단기실황: 지금 기온·습도·강수
async function getNow(grid) {
  let t = kstParts();
  if (t.m < 15) t = kstParts(Date.now() - 3600e3);   // 매시 정각 자료는 10분쯤 뒤에 올라옴
  const items = await getJson(kmaUrl("getUltraSrtNcst", t.ymd, String(t.h).padStart(2, "0") + "00", grid, 20));
  const v = Object.fromEntries(items.map(i => [i.category, i.obsrValue]));
  return {
    time: `${t.h}시`,
    temp: v.T1H != null ? Number(v.T1H) : null,
    humidity: v.REH != null ? Number(v.REH) : null,
    rain1h: v.RN1 != null ? Number(v.RN1) : 0,
    pty: v.PTY != null ? Number(v.PTY) : 0,
    wind: v.WSD != null ? Number(v.WSD) : null,
  };
}

// 단기예보: 오늘 최저/최고, 수업 시간 강수확률·하늘
async function getToday(grid) {
  const now = kstParts();
  // 오늘 02시 발표분에 오늘 하루치(최저·최고 포함)가 모두 들어 있음
  let baseDate = now.ymd, baseTime = "0200";
  if (now.h < 2 || (now.h === 2 && now.m < 15)) { baseDate = kstParts(Date.now() - 86400e3).ymd; baseTime = "2300"; }
  const items = await getJson(kmaUrl("getVilageFcst", baseDate, baseTime, grid, 1000));

  // 최신 발표분으로 덮어쓰기 (02,05,08,11,14,17,20,23시 발표, 10분쯤 뒤 공개)
  const bases = [2, 5, 8, 11, 14, 17, 20, 23].filter(h => h < now.h || (h === now.h && now.m >= 15));
  if (bases.length && bases.at(-1) !== 2) {
    try {
      const latest = await getJson(kmaUrl("getVilageFcst", now.ymd, String(bases.at(-1)).padStart(2, "0") + "00", grid, 1000));
      items.push(...latest);   // 뒤에 오는 값이 우선
    } catch (e) { /* 최신분 실패 시 02시 자료만 사용 */ }
  }

  const today = items.filter(i => i.fcstDate === now.ymd);
  const byHour = {};
  for (const i of today) (byHour[+i.fcstTime.slice(0, 2)] ||= {})[i.category] = i.fcstValue;
  const num = v => (v == null || v === "") ? null : Number(String(v).replace(/[^\d.-]/g, ""));
  const tmn = num(today.filter(i => i.category === "TMN").at(-1)?.fcstValue);
  const tmx = num(today.filter(i => i.category === "TMX").at(-1)?.fcstValue);
  const temps = Object.values(byHour).map(h => num(h.TMP)).filter(v => v != null);

  const school = Object.entries(byHour).filter(([h]) => +h >= SCHOOL_HOURS[0] && +h <= SCHOOL_HOURS[1]);
  const popMax = Math.max(0, ...school.map(([, v]) => num(v.POP) || 0));
  const rainHours = school.filter(([, v]) => num(v.PTY) > 0).map(([h, v]) => ({ hour: +h, pty: num(v.PTY) }));
  const mid = byHour[12] || byHour[13] || byHour[11] || {};

  return {
    tmn: tmn ?? (temps.length ? Math.min(...temps) : null),
    tmx: tmx ?? (temps.length ? Math.max(...temps) : null),
    sky: num(mid.SKY),            // 1 맑음, 3 구름많음, 4 흐림
    pty: num(mid.PTY) || 0,       // 0 없음, 1 비, 2 비/눈, 3 눈, 4 소나기
    popMax,
    rainHours,
  };
}

// 에어코리아: 제주 시내 측정소 실시간
async function getAir() {
  const q = new URLSearchParams({
    serviceKey: process.env.DATA_GO_KR_KEY || "", returnType: "json",
    numOfRows: "100", pageNo: "1", sidoName: "제주", ver: "1.0",
  });
  const items = await getJson(AIR + "?" + q);
  const ok = v => v != null && v !== "-" && v !== "" && !isNaN(Number(v));
  const pick = STATIONS.map(n => items.find(i => i.stationName === n && ok(i.pm10Value)))
    .find(Boolean) || items.find(i => ok(i.pm10Value));
  if (!pick) throw new Error("측정값이 없어요");
  const pm10 = ok(pick.pm10Value) ? Number(pick.pm10Value) : null;
  const pm25 = ok(pick.pm25Value) ? Number(pick.pm25Value) : null;
  return {
    station: pick.stationName,
    time: pick.dataTime,
    pm10, pm25,
    grade10: pm10 == null ? 0 : pm10 <= 30 ? 1 : pm10 <= 80 ? 2 : pm10 <= 150 ? 3 : 4,   // 환경부 기준
    grade25: pm25 == null ? 0 : pm25 <= 15 ? 1 : pm25 <= 35 ? 2 : pm25 <= 75 ? 3 : 4,
    stations: items.map(i => i.stationName),   // 측정소 이름 확인용
  };
}

// 운동장 활동 판단
function judge(now, today, air) {
  const reasons = [];
  let level = "ok";                         // ok / caution / no
  const worst = Math.max(air?.grade10 || 0, air?.grade25 || 0);
  if (worst >= 3) { level = "no"; reasons.push(worst === 4 ? "미세먼지 매우나쁨" : "미세먼지 나쁨"); }
  if (now?.pty > 0 || now?.rain1h > 0) { level = "no"; reasons.push("지금 비/눈"); }
  else if (today?.rainHours?.length) { if (level === "ok") level = "caution"; reasons.push(`${today.rainHours[0].hour}시쯤 비 예보`); }
  else if (today?.popMax >= 60) { if (level === "ok") level = "caution"; reasons.push(`강수확률 ${today.popMax}%`); }
  const hi = today?.tmx ?? now?.temp;
  if (hi != null && hi >= 33) { level = "no"; reasons.push(`폭염 (최고 ${hi}℃)`); }
  else if (hi != null && hi >= 31) { if (level === "ok") level = "caution"; reasons.push(`더위 (최고 ${hi}℃)`); }
  if (now?.temp != null && now.temp <= -5) { if (level === "ok") level = "caution"; reasons.push(`추위 (${now.temp}℃)`); }
  if (now?.wind != null && now.wind >= 9) { if (level === "ok") level = "caution"; reasons.push(`강풍 (${now.wind}m/s)`); }
  const umbrella = (now?.pty > 0) || (today?.rainHours?.length > 0) || (today?.popMax >= 60);
  return { level, reasons, umbrella };
}

export default async () => {
  if (!process.env.DATA_GO_KR_KEY) {
    return Response.json({ error: "Netlify 환경변수 DATA_GO_KR_KEY 가 설정되지 않았어요." }, { status: 500 });
  }
  const grid = toGrid(LAT, LON);
  const [n, t, a] = await Promise.allSettled([getNow(grid), getToday(grid), getAir()]);
  const now = n.status === "fulfilled" ? n.value : null;
  const today = t.status === "fulfilled" ? t.value : null;
  const air = a.status === "fulfilled" ? a.value : null;
  const errors = {};
  if (!now) errors.now = n.reason?.message;
  if (!today) errors.today = t.reason?.message;
  if (!air) errors.air = a.reason?.message;
  if (!now && !today && !air) {
    return Response.json({ error: Object.values(errors)[0] || "날씨 정보를 불러오지 못했어요", errors, grid }, { status: 502 });
  }
  return Response.json(
    { now, today, air, outdoor: judge(now, today, air), errors, grid },
    { headers: { "Cache-Control": "public, max-age=900" } }   // 15분 캐시
  );
};

export const config = { path: "/api/weather" };
