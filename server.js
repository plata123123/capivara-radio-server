import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;
const DB = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, "data.json")
  : "/tmp/capivara-radio-data.json";

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "25mb" }));

const blank = () => ({
  version: 1,
  settings: {},
  clients: {},
  playlists: {},
  jingles: {},
  backgrounds: {},
  updatedAt: new Date().toISOString()
});

function ensure() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });

  if (!fs.existsSync(DB)) {
    fs.writeFileSync(DB, JSON.stringify(blank(), null, 2));
  }
}

function read() {
  ensure();

  try {
    return JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    return blank();
  }
}

function write(d) {
  ensure();
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(DB, JSON.stringify(d, null, 2));
  return d;
}

function code(v = "") {
  return String(v || "").trim().replace(/\D/g, "").slice(-6);
}


// ============================================================
// CAPIVARA RADIO SERVER
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Capivara Radio Server",
    version: "1.1.0"
  });
});


app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString()
  });
});


// ============================================================
// TESTE SEGURO DAS APIS
// Não mostra chaves nem IDs.
// ============================================================

app.get("/api/test-apis", async (req, res) => {

  const result = {
    ok: true,

    environment: {
      geminiKey: !!process.env.GEMINI_API_KEY,
      elevenLabsKey: !!process.env.ELEVENLABS_API_KEY,

      adMale: !!process.env.ELEVENLABS_VOICE_MALE_ID,
      adFemale: !!process.env.ELEVENLABS_VOICE_FEMALE_ID,

      jingleMale: !!process.env.ELEVENLABS_JINGLE_MALE_ID,
      jingleFemale: !!process.env.ELEVENLABS_JINGLE_FEMALE_ID
    },

    gemini: {
      ok: false,
      status: null
    },

    elevenlabs: {
      ok: false,
      status: null
    }
  };


  // ----------------------------------------------------------
  // TESTA GEMINI
  // ----------------------------------------------------------

  try {

    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY não configurada");
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models" +
      "?key=" +
      encodeURIComponent(process.env.GEMINI_API_KEY);

    const response = await fetch(url);

    result.gemini.status = response.status;
    result.gemini.ok = response.ok;

    if (!response.ok) {
      const body = await response.text();
      result.gemini.error = body.slice(0, 300);
    }

  } catch (error) {

    result.gemini.ok = false;
    result.gemini.error = error.message;

  }


  // ----------------------------------------------------------
  // TESTA ELEVENLABS
  // ----------------------------------------------------------

  try {

    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY não configurada");
    }

    const response = await fetch(
      "https://api.elevenlabs.io/v1/voices",
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        }
      }
    );

    result.elevenlabs.status = response.status;
    result.elevenlabs.ok = response.ok;

    if (!response.ok) {
      const body = await response.text();
      result.elevenlabs.error = body.slice(0, 300);
    }

  } catch (error) {

    result.elevenlabs.ok = false;
    result.elevenlabs.error = error.message;

  }


  result.ok =
    result.gemini.ok &&
    result.elevenlabs.ok &&
    Object.values(result.environment).every(Boolean);

  res.status(200).json(result);
});


// ============================================================
// CONFIGURAÇÃO PÚBLICA
// ============================================================

app.get("/api/public/config", (req, res) => {

  const s = read().settings || {};

  res.json({
    ok: true,
    settings: {
      aiMode: s.aiMode || "hybrid",
      voxUrl:
        s.voxUrl ||
        "https://capivara-vox-ai.onrender.com/generate",

      geminiModel: s.geminiModel || "",

      adsPerBlock: s.adsPerBlock ?? 3,
      dailyLimit: s.dailyLimit ?? 15,
      weeklyLimit: s.weeklyLimit ?? 105,
      topDailyLimit: s.topDailyLimit ?? 1,

      useJingles: s.useJingles ?? true
    }
  });
});


// ============================================================
// CLIENTE
// ============================================================

app.get("/api/client/:code", (req, res) => {

  const r = read();

  const c = r.clients?.[code(req.params.code)];

  if (!c) {
    return res.status(404).json({
      ok: false,
      error: "cliente não encontrado"
    });
  }

  if (c.active === false) {
    return res.status(403).json({
      ok: false,
      error: "cliente bloqueado"
    });
  }

  const {
    secrets,
    ...safe
  } = c;

  res.json({
    ok: true,
    client: safe
  });
});


// ============================================================
// CONFIGURAÇÕES ADM
// ============================================================

app.get("/api/admin/settings", (req, res) => {

  res.json({
    ok: true,
    settings: read().settings || {}
  });
});


app.put("/api/admin/settings", (req, res) => {

  const r = read();

  r.settings = {
    ...(r.settings || {}),
    ...(req.body || {})
  };

  write(r);

  res.json({
    ok: true,
    settings: r.settings
  });
});


// ============================================================
// CLIENTES ADM
// ============================================================

app.get("/api/admin/clients", (req, res) => {

  const r = read();

  res.json({
    ok: true,
    clients: Object.values(r.clients || {})
  });
});


app.post("/api/admin/client", (req, res) => {

  const r = read();

  const c = req.body || {};

  c.code = code(c.code);

  if (!c.code) {
    return res.status(400).json({
      ok: false,
      error: "código inválido"
    });
  }

  r.clients[c.code] = {
    ...(r.clients[c.code] || {}),
    ...c,
    code: c.code
  };

  write(r);

  res.json({
    ok: true,
    client: r.clients[c.code]
  });
});


app.delete("/api/admin/client/:code", (req, res) => {

  const r = read();

  delete r.clients[code(req.params.code)];

  write(r);

  res.json({
    ok: true
  });
});


// ============================================================
// ESTADO INDIVIDUAL DE CADA CLIENTE
// ============================================================

app.get("/api/client/:code/state", (req, res) => {

  const r = read();

  const id = code(req.params.code);

  const c = r.clients?.[id];

  if (!c) {
    return res.status(404).json({
      ok: false,
      error: "cliente não encontrado"
    });
  }

  res.json({
    ok: true,
    state: c.state || {
      ads: [],
      queue: [],
      counters: {},
      voiceTurn: 0
    }
  });
});


app.put("/api/client/:code/state", (req, res) => {

  const r = read();

  const id = code(req.params.code);

  if (!r.clients[id]) {
    return res.status(404).json({
      ok: false,
      error: "cliente não encontrado"
    });
  }

  r.clients[id].state = req.body || {};

  write(r);

  res.json({
    ok: true
  });
});


// ============================================================
// PLAYLISTS / VINHETAS / FUNDOS
// ============================================================

for (const k of ["playlists", "jingles", "backgrounds"]) {

  app.get(`/api/${k}`, (req, res) => {

    const r = read();

    res.json({
      ok: true,
      [k]: r[k] || {}
    });
  });


  app.put(`/api/admin/${k}`, (req, res) => {

    const r = read();

    r[k] = req.body || {};

    write(r);

    res.json({
      ok: true
    });
  });
}


// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Capivara Radio Server ativo ${PORT}`);
});
