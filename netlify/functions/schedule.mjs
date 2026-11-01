// 나이스 학사일정 API를 대신 호출하는 Netlify Function
// 인증키는 환경변수 NEIS_API_KEY (급식과 같은 키) 에서 읽습니다.

const API = "https://open.neis.go.kr/hub/";
const OFFICE_CODE = "T10";            // 제주특별자치도교육청
const SCHOOL_NAME = "물메초등학교";
let schoolCode = process.env.SCHOOL_CODE || "";

async function neis(service, params) {
  const q = new URLSearchParams({ Type: "json", pIndex: "1", pSize: "500", ...params });
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
const GRADE_KEYS = ["ONE_GRADE_EVENT_YN","TW_GRADE_EVENT_YN","THREE_GRADE_EVENT_YN",
                    "FR_GRADE_EVENT_YN","FIV_GRADE_EVENT_YN","SIX_GRADE_EVENT_YN"];

export default async (req) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isYmd(from) || !isYmd(to)) {
    return Response.json({ error: "from, to 날짜(YYYYMMDD)가 필요합니다." }, { status: 400 });
  }
  try {
    const code = await getSchoolCode();
    const rows = await neis("SchoolSchedule", {
      ATPT_OFCDC_SC_CODE: OFFICE_CODE,
      SD_SCHUL_CODE: code,
      AA_FROM_YMD: from,
      AA_TO_YMD: to,
    });
    const events = rows.map(r => ({
      date: r.AA_YMD,
      name: (r.EVENT_NM || "").trim(),
      content: (r.EVENT_CNTNT || "").trim(),
      dayType: r.SBTR_DD_SC_NM || "",                       // 휴업일 / 공휴일 / 해당없음
      grades: GRADE_KEYS.map((k, i) => r[k] === "Y" ? i + 1 : 0).filter(Boolean),
    })).sort((a, b) => a.date.localeCompare(b.date));
    return Response.json({ events }, { headers: { "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

export const config = { path: "/api/schedule" };
