require("dotenv").config();

const express = require("express");
const cors    = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ── 구글시트 ID (환경변수로 관리) ───────────────────────────
const ID_AUTH_SHEET_ID = process.env.SHEET_ID_AUTH;  // ID 인증 시트 ID
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL       = 'llama-3.1-8b-instant';

// ── 시트 URL 생성 헬퍼 ───────────────────────────────────────
function sheetTsvUrl(sheetUrl, gid) {
  const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!idMatch) return null;
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=tsv&gid=${gid || '0'}`;
}

function sheetCsvUrl(sheetUrl, gid) {
  const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!idMatch) {
    // URL이 아닌 순수 ID인 경우
    return `https://docs.google.com/spreadsheets/d/${sheetUrl}/export?format=csv&gid=${gid || '0'}`;
  }
  const gidMatch = sheetUrl.match(/gid=(\d+)/);
  const finalGid = gid || (gidMatch ? gidMatch[1] : '0');
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${finalGid}`;
}

// ── 파싱 유틸 ────────────────────────────────────────────────
function parseCSVRow(row) {
  row = row.replace(/\r/g, '');
  const cols = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseTSV(text) {
  const lines   = text.split('\n');
  const headers = lines[0].split('\t').map(h => h.replace(/\r/g,'').trim());
  const rows    = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g,'');
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

function cleanAnswer(raw) {
  raw = raw.trim();
  if (raw.includes('\n\n')) raw = raw.split('\n\n')[0].trim();
  if (raw.includes('\n'))   raw = raw.split('\n')[0].trim();
  const endings = ['니다.','니다!','니다?','세요.','세요!','어요.','어요!','아요.','아요!',
                   '죠.','죠!','요.','요!','같아요.','같아요!','니다','어요','아요','세요','같아요'];
  for (const sep of endings) {
    if (raw.includes(sep)) {
      raw = raw.substring(0, raw.indexOf(sep) + sep.length).trim();
      break;
    }
  }
  if (raw.length > 90) {
    const shortened = raw.substring(0, 90);
    for (const sep of ['요.','요!','다.','다!','요','다']) {
      const idx = shortened.lastIndexOf(sep);
      if (idx > 30) { raw = shortened.substring(0, idx + sep.length).trim(); break; }
    }
    if (raw.length > 90) raw = shortened.trim();
  }
  return raw;
}

// ── 스펙 데이터 파싱 ─────────────────────────────────────────
async function parseSpecData(specUrl) {
  const res      = await fetch(specUrl);
  const specText = await res.text();
  const { headers: specHeaders, rows: specRows } = parseTSV(specText);
  const giftCols = specHeaders.filter(h => h.startsWith('사은품'));

  let specContext = '[갤럭시북 스펙 데이터]\n';
  const modelMap  = {};
  const groupMap  = {};

  for (const row of specRows) {
    const parts = [];
    for (const [col, val] of Object.entries(row)) {
      const v = val.replace(/\n/g,' ').replace(/\r/g,'').trim();
      if (v && v !== 'nan') parts.push(col + '=' + v);
    }
    if (!parts.length) continue;
    const line = parts.join(' / ');
    specContext += line + '\n';

    const modelGroup  = (row['모델군'] || '').replace(/\n/g,' ').trim();
    const productName = (row['제품명'] || '').replace(/\n/g,' ').trim();
    const abbrRaw     = (row['축약 모델명'] || '').trim();
    const groupRaw    = (row['제품군 축약'] || '').trim();
    const abbrList    = abbrRaw.split(/[\n,]/).map(a => a.trim()).filter(a => a && a !== 'nan' && a !== '0');
    const groupList   = groupRaw.split(/[\n,]/).map(g => g.trim()).filter(g => g && g !== 'nan');
    const gifts       = giftCols.map(gc => (row[gc]||'').replace(/\n/g,' ').trim()).filter(v => v && v !== 'nan');

    for (const g of groupList) {
      if (!groupMap[g]) groupMap[g] = modelGroup;
      g.split(/\s+/).forEach(part => {
        if (part && part.length >= 2 && !groupMap[part]) groupMap[part] = modelGroup;
      });
    }
    for (const abbr of abbrList) {
      if (!modelMap[abbr]) modelMap[abbr] = [];
      modelMap[abbr].push({ modelGroup, groupAbbr: groupList[0] || modelGroup, productName, gifts, line });
    }
  }

  return { specContext, modelMap, groupMap };
}

// ── 키워드 파싱 ──────────────────────────────────────────────
async function parseKeywords(csvUrl) {
  const res  = await fetch(csvUrl);
  const text = await res.text();
  const rows = text.trim().split('\n').slice(1);

  return rows.flatMap(row => {
    const cols    = parseCSVRow(row);
    const kwRaw   = (cols[0] || '').trim();
    const videoKw = (cols[1] || '').trim();
    const answer  = (cols[2] || '').trim();
    if (!kwRaw) return [];
    return kwRaw.split(',').map(k => k.trim()).filter(Boolean).map(kw => ({
      keyword: kw, videoKeyword: videoKw, answer, src: 'sheet'
    }));
  });
}

// ── GET / ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Live AI Server OK");
});

// ── POST /verifyId ───────────────────────────────────────────
// ID 인증 시트에서 ID 확인 후 해당 ID의 모든 시트 URL 반환
app.post("/verifyId", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.json({ ok: false, error: 'ID 필요' });

    const authUrl  = `https://docs.google.com/spreadsheets/d/${ID_AUTH_SHEET_ID}/export?format=csv&gid=0`;
    const response = await fetch(authUrl);
    const text     = await response.text();
    const rows     = text.trim().split('\n').slice(1);

    for (const row of rows) {
      const cols    = parseCSVRow(row);
      const sheetId = (cols[0] || '').trim();
      if (sheetId !== id) continue;

      // 시트 컬럼 구조:
      // 0: 라이브ID
      // 1: 댓글 대응 프롬프트 주소 (키워드_네이버)
      // 2: 시스템 지침 주소
      // 3: 스펙_네이버 주소
      // 4: 추가 정보 주소
      // 5: 가격 주소
      // 6: 키워드_11번가 주소
      // 7: 스펙_11번가 주소
      return res.json({
        ok: true,
        urls: {
          keyword:      (cols[1] || '').trim(),
          systemPrompt: (cols[2] || '').trim(),
          naverSpec:    (cols[3] || '').trim(),
          extraInfo:    (cols[4] || '').trim(),
          price:        (cols[5] || '').trim(),
          kwMatch11st:  (cols[6] || '').trim(),
          spec11st:     (cols[7] || '').trim(),
        }
      });
    }

    res.json({ ok: false, error: '잘못된 ID' });

  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /getSpec ─────────────────────────────────────────────
// urls.naverSpec 또는 urls.spec11st URL로 스펙 데이터 반환
app.post("/getSpec", async (req, res) => {
  try {
    const { specUrl, systemPromptUrl } = req.body;
    if (!specUrl) return res.json({ ok: false, error: 'specUrl 필요' });

    // 시스템 지침 로딩
    let systemPrompt = '';
    if (systemPromptUrl) {
      try {
        const sysRes   = await fetch(systemPromptUrl);
        const sysText  = await sysRes.text();
        const sysLines = sysText.split('\n')
          .map(l => l.split('\t')[0].replace(/\r/g,'').replace(/^"|"$/g,'').trim())
          .filter(l => l);
        systemPrompt = sysLines.join('\n');
      } catch(e) {}
    }

    // 스펙 데이터 로딩
    const { specContext, modelMap, groupMap } = await parseSpecData(specUrl);

    res.json({ ok: true, specContext, modelMap, groupMap, systemPrompt });

  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /getSheetData ───────────────────────────────────────
// urls.keyword 또는 urls.kwMatch11st URL로 키워드 반환
app.post("/getSheetData", async (req, res) => {
  try {
    const { sheetUrl } = req.body;
    if (!sheetUrl) return res.json({ ok: false, error: 'sheetUrl 필요' });

    const csvUrl  = sheetCsvUrl(sheetUrl);
    const keywords = await parseKeywords(csvUrl);

    res.json({ ok: true, keywords });

  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /askAI ──────────────────────────────────────────────
app.post("/askAI", async (req, res) => {
  try {
    const { prompt, systemPrompt } = req.body;
    if (!prompt) return res.json({ ok: false, error: 'prompt 필요' });

    const fullPrompt = '아래 [데이터]만 보고 [질문]에 답해. [데이터] 외 내용 절대 금지. 추측 금지.\n\n' + prompt;

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt || '너는 삼성 갤럭시북 라이브 방송 채팅 응대 도우미야. 반드시 한국어로 90자 이내 1문장으로 답변해.' },
          { role: 'user',   content: fullPrompt }
        ],
        max_tokens: 300,
        temperature: 0.1,
        stop: ['시청자 질문:', '[질문]', '[데이터]']
      })
    });

    const data   = await response.json();
    const raw    = (data.choices?.[0]?.message?.content || '').trim();
    const answer = cleanAnswer(raw);

    console.log('[AI답변]', answer);
    res.json({ ok: true, answer });

  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 서버 시작 ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on ' + PORT);
});
