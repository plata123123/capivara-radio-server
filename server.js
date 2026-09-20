import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined
});

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "25mb" }));

function blank() {
  return {
    version: 2,
    settings: {},
    clients: {},
    playlists: {},
    jingles: {},
    backgrounds: {},
    updatedAt: new Date().toISOString()
  };
}

function cleanCode(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS capivara_store (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    `
    INSERT INTO capivara_store (id, data)
    VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(blank())]
  );
}

async function readData() {
  const result = await pool.query(
    "SELECT data FROM capivara_store WHERE id = 1"
  );

  return result.rows[0]?.data || blank();
}

async function writeData(data) {
  data.updatedAt = new Date().toISOString();

  await pool.query(
    `
    UPDATE capivara_store
    SET data = $1::jsonb,
        updated_at = NOW()
    WHERE id = 1
    `,
    [JSON.stringify(data)]
  );

  return data;
}

function safe(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error(error);

      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: "erro interno do servidor"
        });
      }
    }
  };
}

/* =========================================================
   STATUS
========================================================= */

app.get("/", safe(async (req, res) => {
  res.json({
    ok: true,
    service: "Capivara Radio Server",
    version: "2.0.0",
    database: "postgres"
  });
}));

app.get("/health", safe(async (req, res) => {
  await pool.query("SELECT 1");

  res.json({
    ok: true,
    database: "postgres",
    time: new Date().toISOString()
  });
}));

app.get("/api/environment-status", safe(async (req, res) => {
  const data = await readData();
  const settings = data.settings || {};

  const textKeys =
    settings.apiPool?.text?.some(x => x.enabled && x.key) ||
    !!process.env.GEMINI_API_KEY;

  const voiceKeys =
    settings.apiPool?.voice?.some(x => x.enabled && x.key) ||
    !!process.env.ELEVENLABS_API_KEY;

  res.json({
    ok: true,
    database: true,
    databaseType: "postgres",
    gemini: !!textKeys,
    elevenlabs: !!voiceKeys
  });
}));

/* =========================================================
   CONFIGURAÇÃO PÚBLICA DO PLAYER
========================================================= */

app.get("/api/public/config", safe(async (req, res) => {
  const data = await readData();
  const settings = data.settings || {};

  res.json({
    ok: true,
    settings: {
      aiMode: settings.aiMode || "hybrid",

      voxUrl:
        settings.voxUrl ||
        "https://capivara-vox-ai.onrender.com/generate",

      geminiModel:
        settings.geminiModel ||
        "gemini-2.5-flash",

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
}));

/* =========================================================
   CLIENTE
========================================================= */

app.get("/api/client/:code", safe(async (req, res) => {
  const data = await readData();

  const client =
    data.clients?.[cleanCode(req.params.code)];

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
    ...publicClient
  } = client;

  res.json({
    ok: true,
    client: publicClient
  });
}));

/* =========================================================
   CONFIGURAÇÕES DO ADM
========================================================= */

app.get("/api/admin/settings", safe(async (req, res) => {
  const data = await readData();

  res.json({
    ok: true,
    settings: data.settings || {}
  });
}));

app.put("/api/admin/settings", safe(async (req, res) => {
  const data = await readData();

  data.settings = {
    ...(data.settings || {}),
    ...(req.body || {})
  };

  await writeData(data);

  res.json({
    ok: true,
    settings: data.settings
  });
}));

/* =========================================================
   CLIENTES DO ADM
========================================================= */

app.get("/api/admin/clients", safe(async (req, res) => {
  const data = await readData();

  res.json({
    ok: true,
    clients: Object.values(data.clients || {})
  });
}));

async function saveClient(req, res) {
  const body = req.body || {};

  const clientCode = cleanCode(
    req.params?.code ||
    body.code ||
    body.codigo
  );

  if (!clientCode) {
    return res.status(400).json({
      ok: false,
      error: "código inválido"
    });
  }

  const data = await readData();

  data.clients ||= {};

  data.clients[clientCode] = {
    ...(data.clients[clientCode] || {}),
    ...body,
    code: clientCode
  };

  await writeData(data);

  res.json({
    ok: true,
    client: data.clients[clientCode]
  });
}

app.post(
  "/api/admin/client",
  safe(saveClient)
);

app.put(
  "/api/admin/client/:code",
  safe(saveClient)
);

app.delete(
  "/api/admin/client/:code",
  safe(async (req, res) => {

    const data = await readData();

    const clientCode =
      cleanCode(req.params.code);

    if (data.clients) {
      delete data.clients[clientCode];
    }

    await writeData(data);

    res.json({
      ok: true
    });
  })
);

/* =========================================================
   ESTADO INDIVIDUAL DE CADA RÁDIO
========================================================= */

app.get(
  "/api/client/:code/state",
  safe(async (req, res) => {

    const data = await readData();

    const client =
      data.clients?.[
        cleanCode(req.params.code)
      ];

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
  })
);

app.put(
  "/api/client/:code/state",
  safe(async (req, res) => {

    const clientCode =
      cleanCode(req.params.code);

    const data =
      await readData();

    if (!data.clients?.[clientCode]) {
      return res.status(404).json({
        ok: false,
        error: "cliente não encontrado"
      });
    }

    data.clients[clientCode].state =
      req.body || {};

    await writeData(data);

    res.json({
      ok: true
    });
  })
);

/* =========================================================
   PLAYLISTS / VINHETAS / FUNDOS
========================================================= */

for (const key of [
  "playlists",
  "jingles",
  "backgrounds"
]) {

  app.get(
    `/api/${key}`,
    safe(async (req, res) => {

      const data =
        await readData();

      res.json({
        ok: true,
        [key]: data[key] || {}
      });
    })
  );

  app.put(
    `/api/admin/${key}`,
    safe(async (req, res) => {

      const data =
        await readData();

      data[key] =
        req.body || {};

      await writeData(data);

      res.json({
        ok: true
      });
    })
  );
}

/* =========================================================
   TESTE DAS CHAVES
========================================================= */

app.get(
  "/api/test-apis",
  safe(async (req, res) => {

    const data =
      await readData();

    const settings =
      data.settings || {};

    res.json({
      ok: true,

      textKeys:
        (
          settings.apiPool?.text || []
        ).filter(
          x => x.enabled && x.key
        ).length,

      voiceKeys:
        (
          settings.apiPool?.voice || []
        ).filter(
          x => x.enabled && x.key
        ).length
    });
  })
);

/* =========================================================
   TESTE ELEVENLABS
========================================================= */

app.post(
  "/api/test-voice",
  safe(async (req, res) => {

    const data =
      await readData();

    const settings =
      data.settings || {};

    const keys =
      (
        settings.apiPool?.voice || []
      ).filter(
        x => x.enabled && x.key
      );

    const apiKey =
      keys[0]?.key ||
      process.env.ELEVENLABS_API_KEY;

    const voiceId =
      req.body?.voiceId ||
      settings.voices?.adMale ||
      process.env.ELEVENLABS_VOICE_MALE_ID;

    if (!apiKey || !voiceId) {
      return res.status(400).json({
        ok: false,
        error:
          "chave/voice ID não configurados"
      });
    }

    const response =
      await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: "POST",

          headers: {
            "xi-api-key": apiKey,
            "Content-Type":
              "application/json",
            "Accept":
              "audio/mpeg"
          },

          body: JSON.stringify({
            text:
              req.body?.text ||
              "teste de voz capivara rádio",

            model_id:
              "eleven_multilingual_v2"
          })
        }
      );

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          ok: false,
          error:
            await response.text()
        });
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );

    res.send(buffer);
  })
);

/* =========================================================
   INICIALIZAÇÃO
========================================================= */

await initDb();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Capivara Radio Server V2 + Postgres ativo",
      PORT
    );
  }
);
