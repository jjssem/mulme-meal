// 나이스 급식 API를 대신 호출하는 Netlify Function
// 인증키는 Netlify 환경변수 NEIS_API_KEY 에서 읽습니다 (코드·페이지에 노출되지 않음).

const API = "https://open.neis.go.kr/hub/";
const OFFICE_CODE = "T10";            // 제주특별자치도교육청
const SCHOOL_NAME = "물메초등학교";
let schoolCode = process.env.SCHOOL_CODE || "";   // 한 번 찾으면 재사용

async function neis(service, params) {
  const q = new URLSearchParams({ Type: "json", pIndex: "1", pSize: "30", ...params });
  if (process.env.NEIS_API_KEY) q.set("KEY", process.env.NEIS_API_KEY);
  const res = await fetch(API + service + "?" + q);
  if (!res.ok) throw new Error("나이스 서버 응답 오류 (" + res.status + ")");
  const json = await res.json();
  if (json.RESULT) {
    if (json.RESULT.CODE === "INFO-200") return [];   // 데이터 없음
    throw new Error(json.RESULT.MESSAGE);
  }
  return json[service][1].row;
}

async function getSchoolCode() {
  if (schoolCode) return schoolCode;
  const rows = await neis("schoolInfo", { ATPT_OFCDC_SC_CODE: OFFICE_CODE, SCHUL_NM: SCHOOL_NAME });
  const hit = rows.find(r => r.SCHUL_NM === SCHOOL_NAME) || rows[0];
  if (!hit) throw new Error("학교를 찾지 못했습니다: " + SCHOOL_NAME);
  schoolCode = hit.SD_SCHUL_CODE;
  return schoolCode;
}

const isYmd = s => /^\d{8}$/.test(s || "");

export default async (req) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isYmd(from) || !isYmd(to)) {
    return Response.json({ error: "from, to 날짜(YYYYMMDD)가 필요합니다." }, { status: 400 });
  }
  try {
    const code = await getSchoolCode();
    const rows = await neis("mealServiceDietInfo", {
      ATPT_OFCDC_SC_CODE: OFFICE_CODE,
      SD_SCHUL_CODE: code,
      MMEAL_SC_CODE: "2",           // 중식
      MLSV_FROM_YMD: from,
      MLSV_TO_YMD: to,
    });
    // 페이지에 필요한 항목만 전달
    const meals = rows
      .map(r => ({ date: r.MLSV_YMD, dishes: r.DDISH_NM, kcal: r.CAL_INFO }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return Response.json({ meals }, { headers: { "Cache-Control": "public, max-age=1800" } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

export const config = { path: "/api/meal" };
