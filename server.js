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


// ============================================================
// BANCO PROVISÓRIO
// ============================================================

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
    fs.writeFileSync(
      DB,
      JSON.stringify(blank(), null, 2)
    );
  }
}

function read() {
  ensure();

  try {
    return JSON.parse(
      fs.readFileSync(DB, "utf8")
    );
  } catch {
    return blank();
  }
}

function write(data) {
  ensure();

  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(
    DB,
    JSON.stringify(data, null, 2)
  );

  return data;
}

function code(value = "") {
  return String(value || "")
    .trim()
    .replace(/\D/g, "")
    .slice(-6);
}


// ============================================================
// CAPIVARA RADIO SERVER
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Capivara Radio Server",
    version: "1.2.0"
  });
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Capivara Radio Server",
    version: "1.2.0",
    time: new Date().toISOString()
  });
});


// ============================================================
// STATUS DAS CONFIGURAÇÕES
// NÃO EXPÕE CHAVES NEM IDs
// ============================================================

app.get("/api/environment-status", (req, res) => {
  res.json({
    ok: true,

    gemini: {
      keyConfigured: Boolean(
        process.env.GEMINI_API_KEY
      )
    },

    elevenlabs: {
      keyConfigured: Boolean(
        process.env.ELEVENLABS_API_KEY
      ),

      adMaleConfigured: Boolean(
        process.env.ELEVENLABS_VOICE_MALE_ID
      ),

      adFemaleConfigured: Boolean(
        process.env.ELEVENLABS_VOICE_FEMALE_ID
      ),

      jingleMaleConfigured: Boolean(
        process.env.ELEVENLABS_JINGLE_MALE_ID
      ),

      jingleFemaleConfigured: Boolean(
        process.env.ELEVENLABS_JINGLE_FEMALE_ID
      )
    }
  });
});


// ============================================================
// TESTE GEMINI + CONFIGURAÇÃO ELEVENLABS
// ============================================================

app.get("/api/test-apis", async (req, res) => {

  const result = {
    ok: true,

    environment: {
      geminiKey:
        Boolean(process.env.GEMINI_API_KEY),

      elevenLabsKey:
        Boolean(process.env.ELEVENLABS_API_KEY),

      adMale:
        Boolean(process.env.ELEVENLABS_VOICE_MALE_ID),

      adFemale:
        Boolean(process.env.ELEVENLABS_VOICE_FEMALE_ID),

      jingleMale:
        Boolean(process.env.ELEVENLABS_JINGLE_MALE_ID),

      jingleFemale:
        Boolean(process.env.ELEVENLABS_JINGLE_FEMALE_ID)
    },

    gemini: {
      ok: false,
      status: null
    },

    elevenlabs: {
      configured: false,
      note: "Use /api/test-voice para testar geração real de áudio."
    }
  };


  // ----------------------------------------------------------
  // TESTA A CHAVE GEMINI
  // ----------------------------------------------------------

  try {

    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        "GEMINI_API_KEY não configurada"
      );
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models" +
      "?key=" +
      encodeURIComponent(
        process.env.GEMINI_API_KEY
      );

    const response = await fetch(url);

    result.gemini.status = response.status;
    result.gemini.ok = response.ok;

    if (!response.ok) {
      const body = await response.text();

      result.gemini.error =
        body.slice(0, 300);
    }

  } catch (error) {

    result.gemini.ok = false;
    result.gemini.error = error.message;
  }


  result.elevenlabs.configured =
    result.environment.elevenLabsKey &&
    result.environment.adMale &&
    result.environment.adFemale &&
    result.environment.jingleMale &&
    result.environment.jingleFemale;


  result.ok =
    result.gemini.ok &&
    result.elevenlabs.configured;


  res.status(200).json(result);
});


// ============================================================
// TESTE REAL ELEVENLABS
// GERA MP3 USANDO A VOZ MASCULINA DOS ANÚNCIOS
// ============================================================

app.get("/api/test-voice", async (req, res) => {

  try {

    const apiKey =
      process.env.ELEVENLABS_API_KEY;

    const voiceId =
      process.env.ELEVENLABS_VOICE_MALE_ID;


    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error:
          "ELEVENLABS_API_KEY não configurada"
      });
    }


    if (!voiceId) {
      return res.status(500).json({
        ok: false,
        error:
          "ELEVENLABS_VOICE_MALE_ID não configurado"
      });
    }


    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",

        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },

        body: JSON.stringify({
          text:
            "teste de voz da capivara rádio.",

          model_id:
            "eleven_multilingual_v2"
        })
      }
    );


    if (!response.ok) {

      const errorBody =
        await response.text();

      return res
        .status(response.status)
        .json({
          ok: false,
          status: response.status,
          error:
            errorBody.slice(0, 500)
        });
    }


    const audio =
      Buffer.from(
        await response.arrayBuffer()
      );


    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );

    res.setHeader(
      "Content-Disposition",
      'inline; filename="teste-capivara.mp3"'
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.send(audio);

  } catch (error) {

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});


// ============================================================
// CONFIGURAÇÃO PÚBLICA
// ============================================================

app.get("/api/public/config", (req, res) => {

  const settings =
    read().settings || {};

  res.json({
    ok: true,

    settings: {

      aiMode:
        settings.aiMode ||
        "hybrid",

      voxUrl:
        settings.voxUrl ||
        "https://capivara-vox-ai.onrender.com/generate",

      geminiModel:
        settings.geminiModel || "",

      adsPerBlock:
        settings.adsPerBlock ?? 3,

      dailyLimit:
        settings.dailyLimit ?? 15,

      weeklyLimit:
        settings.weeklyLimit ?? 105,

      topDailyLimit:
        settings.topDailyLimit ?? 1,

      useJingles:
        settings.useJingles ?? true
    }
  });
});


// ============================================================
// CLIENTE - DADOS
// ============================================================

app.get("/api/client/:code", (req, res) => {

  const database = read();

  const clientCode =
    code(req.params.code);

  const client =
    database.clients?.[clientCode];


  if (!client) {

    return res.status(404).json({
      ok: false,
      error: "cliente não encontrado"
    });
  }


  if (client.active === false) {

    return res.status(403).json({
      ok: false,
      error: "cliente bloqueado"
    });
  }


  const {
    secrets,
    ...safeClient
  } = client;


  res.json({
    ok: true,
    client: safeClient
  });
});


// ============================================================
// CONFIGURAÇÕES ADM
// ============================================================

app.get("/api/admin/settings", (req, res) => {

  res.json({
    ok: true,
    settings:
      read().settings || {}
  });
});


app.put("/api/admin/settings", (req, res) => {

  const database = read();

  database.settings = {
    ...(database.settings || {}),
    ...(req.body || {})
  };

  write(database);

  res.json({
    ok: true,
    settings:
      database.settings
  });
});


// ============================================================
// CLIENTES ADM
// ============================================================

app.get("/api/admin/clients", (req, res) => {

  const database = read();

  res.json({
    ok: true,
    clients:
      Object.values(
        database.clients || {}
      )
  });
});


app.post("/api/admin/client", (req, res) => {

  const database = read();

  const client =
    req.body || {};

  client.code =
    code(client.code);


  if (!client.code) {

    return res.status(400).json({
      ok: false,
      error: "código inválido"
    });
  }


  database.clients[client.code] = {
    ...(database.clients[client.code] || {}),
    ...client,
    code: client.code
  };


  write(database);


  res.json({
    ok: true,
    client:
      database.clients[client.code]
  });
});


app.delete("/api/admin/client/:code", (req, res) => {

  const database = read();

  const clientCode =
    code(req.params.code);

  delete database.clients[clientCode];

  write(database);

  res.json({
    ok: true
  });
});


// ============================================================
// ESTADO INDIVIDUAL DE CADA CLIENTE
// ============================================================

app.get("/api/client/:code/state", (req, res) => {

  const database = read();

  const clientCode =
    code(req.params.code);

  const client =
    database.clients?.[clientCode];


  if (!client) {

    return res.status(404).json({
      ok: false,
      error: "cliente não encontrado"
    });
  }


  res.json({
    ok: true,

    state:
      client.state || {
        ads: [],
        queue: [],
        counters: {},
        voiceTurn: 0
      }
  });
});


app.put("/api/client/:code/state", (req, res) => {

  const database = read();

  const clientCode =
    code(req.params.code);


  if (!database.clients[clientCode]) {

    return res.status(404).json({
      ok: false,
      error: "cliente não encontrado"
    });
  }


  database.clients[clientCode].state =
    req.body || {};


  write(database);


  res.json({
    ok: true
  });
});


// ============================================================
// PLAYLISTS
// ============================================================

app.get("/api/playlists", (req, res) => {

  const database = read();

  res.json({
    ok: true,
    playlists:
      database.playlists || {}
  });
});


app.put("/api/admin/playlists", (req, res) => {

  const database = read();

  database.playlists =
    req.body || {};

  write(database);

  res.json({
    ok: true
  });
});


// ============================================================
// VINHETAS
// ============================================================

app.get("/api/jingles", (req, res) => {

  const database = read();

  res.json({
    ok: true,
    jingles:
      database.jingles || {}
  });
});


app.put("/api/admin/jingles", (req, res) => {

  const database = read();

  database.jingles =
    req.body || {};

  write(database);

  res.json({
    ok: true
  });
});


// ============================================================
// FUNDOS DE LOCUÇÃO
// ============================================================

app.get("/api/backgrounds", (req, res) => {

  const database = read();

  res.json({
    ok: true,
    backgrounds:
      database.backgrounds || {}
  });
});


app.put("/api/admin/backgrounds", (req, res) => {

  const database = read();

  database.backgrounds =
    req.body || {};

  write(database);

  res.json({
    ok: true
  });
});


// ============================================================
// ERRO 404
// ============================================================

app.use((req, res) => {

  res.status(404).json({
    ok: false,
    error: "rota não encontrada"
  });
});


// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Capivara Radio Server ativo ${PORT}`
    );
  }
);
