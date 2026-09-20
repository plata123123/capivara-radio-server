import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

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
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Admin-Password",
    "X-File-Name",
    "X-Media-Kind"
  ],
  exposedHeaders: [
    "Content-Length",
    "Content-Type",
    "X-Capivara-Key-Slot"
  ]
}));

app.use(express.json({ limit: "25mb" }));

function blank() {
  return {
    version: 4,
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

function cleanMediaId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

function makeId(prefix = "media") {
  return (
    prefix +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 10)
  );
}

function safeFileName(value) {
  return String(value || "audio")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 220);
}

function safeMediaKind(value) {
  const kind = String(value || "music")
    .trim()
    .toLowerCase();

  const allowed = [
    "music",
    "jingle",
    "background",
    "ad"
  ];

  return allowed.includes(kind)
    ? kind
    : "music";
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS capivara_media (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      file_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS capivara_media_kind_idx
    ON capivara_media(kind)
  `);
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
   SEGURANÇA DO ADM
========================================================= */

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      ok: false,
      error: "ADMIN_PASSWORD não configurada no servidor"
    });
  }

  const password =
    req.get("X-Admin-Password") || "";

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: "acesso administrativo não autorizado"
    });
  }

  next();
}

function maskSecret(value) {
  const text = String(value || "");

  if (!text) return "";

  if (text.length <= 8) {
    return "••••••••";
  }

  return (
    text.slice(0, 3) +
    "••••••••" +
    text.slice(-4)
  );
}

function sanitizeSettings(settings = {}) {
  const clone = JSON.parse(
    JSON.stringify(settings || {})
  );

  if (clone.apiPool?.text) {
    clone.apiPool.text =
      clone.apiPool.text.map((item, index) => ({
        slot: index + 1,
        enabled: !!item.enabled,
        configured: !!item.key,
        masked: maskSecret(item.key)
      }));
  }

  if (clone.apiPool?.voice) {
    clone.apiPool.voice =
      clone.apiPool.voice.map((item, index) => ({
        slot: index + 1,
        enabled: !!item.enabled,
        configured: !!item.key,
        masked: maskSecret(item.key)
      }));
  }

  return clone;
}

function normalizePool(poolItems = [], oldItems = []) {
  const result = [];

  for (let i = 0; i < 3; i++) {
    const incoming = poolItems[i] || {};
    const old = oldItems[i] || {};

    result.push({
      enabled:
        incoming.enabled !== undefined
          ? !!incoming.enabled
          : !!old.enabled,

      key:
        incoming.key
          ? String(incoming.key).trim()
          : String(old.key || "").trim()
    });
  }

  return result;
}

function activeKeys(items = []) {
  return items
    .filter(item => item?.enabled && item?.key)
    .map(item => String(item.key).trim());
}

/* =========================================================
   STATUS
========================================================= */

app.get("/", safe(async (req, res) => {
  res.json({
    ok: true,
    service: "Capivara Radio Server",
    version: "3.2.0",
    database: "postgres",
    adminSecurity: true,
    apiFailover: true,
    onlineMedia: true
  });
}));

app.get("/health", safe(async (req, res) => {
  await pool.query("SELECT 1");

  const mediaResult = await pool.query(
    "SELECT COUNT(*)::int AS total FROM capivara_media"
  );

  res.json({
    ok: true,
    database: "postgres",
    version: "3.2.0",
    onlineMedia: true,
    mediaFiles: mediaResult.rows[0]?.total || 0,
    time: new Date().toISOString()
  });
}));

app.get(
  "/api/environment-status",
  safe(async (req, res) => {
    const data = await readData();
    const settings = data.settings || {};

    const textKeys =
      activeKeys(settings.apiPool?.text).length ||
      (process.env.GEMINI_API_KEY ? 1 : 0);

    const voiceKeys =
      activeKeys(settings.apiPool?.voice).length ||
      (process.env.ELEVENLABS_API_KEY ? 1 : 0);

    res.json({
      ok: true,
      database: true,
      databaseType: "postgres",
      onlineMedia: true,
      gemini: textKeys > 0,
      elevenlabs: voiceKeys > 0,
      textKeysActive: textKeys,
      voiceKeysActive: voiceKeys
    });
  })
);

/* =========================================================
   CONFIGURAÇÃO PÚBLICA
========================================================= */

app.get(
  "/api/public/config",
  safe(async (req, res) => {
    const data = await readData();
    const settings = data.settings || {};

    res.json({
      ok: true,
      settings: {
        aiMode:
          settings.aiMode || "hybrid",

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
  })
);

/* =========================================================
   CLIENTE
========================================================= */

app.get(
  "/api/client/:code",
  safe(async (req, res) => {
    const data = await readData();
    const code = cleanCode(req.params.code);
    const client = data.clients?.[code];

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
      state,
      ...publicClient
    } = client;

    res.json({
      ok: true,
      client: publicClient
    });
  })
);

/* =========================================================
   LOGIN ADM
========================================================= */

app.post(
  "/api/admin/login",
  adminAuth,
  (req, res) => {
    res.json({
      ok: true,
      authenticated: true
    });
  }
);

/* =========================================================
   CONFIGURAÇÕES ADM
========================================================= */

app.get(
  "/api/admin/settings",
  adminAuth,
  safe(async (req, res) => {
    const data = await readData();

    res.json({
      ok: true,
      settings: sanitizeSettings(
        data.settings || {}
      )
    });
  })
);

app.put(
  "/api/admin/settings",
  adminAuth,
  safe(async (req, res) => {
    const data = await readData();
    const oldSettings = data.settings || {};
    const incoming = req.body || {};

    const newSettings = {
      ...oldSettings,
      ...incoming
    };

    if (incoming.apiPool) {
      newSettings.apiPool = {
        text: normalizePool(
          incoming.apiPool.text || [],
          oldSettings.apiPool?.text || []
        ),

        voice: normalizePool(
          incoming.apiPool.voice || [],
          oldSettings.apiPool?.voice || []
        )
      };
    }

    if (incoming.voices) {
      newSettings.voices = {
        ...(oldSettings.voices || {}),
        ...incoming.voices
      };
    }

    data.settings = newSettings;

    await writeData(data);

    res.json({
      ok: true,
      settings:
        sanitizeSettings(newSettings)
    });
  })
);

/* =========================================================
   CLIENTES ADM
========================================================= */

app.get(
  "/api/admin/clients",
  adminAuth,
  safe(async (req, res) => {
    const data = await readData();

    res.json({
      ok: true,
      clients: Object.values(
        data.clients || {}
      ).map(client => {
        const {
          secrets,
          state,
          ...safeClient
        } = client;

        return safeClient;
      })
    });
  })
);

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

  const {
    secrets,
    state,
    ...safeClient
  } = data.clients[clientCode];

  res.json({
    ok: true,
    client: safeClient
  });
}

app.post(
  "/api/admin/client",
  adminAuth,
  safe(saveClient)
);

app.put(
  "/api/admin/client/:code",
  adminAuth,
  safe(saveClient)
);

app.delete(
  "/api/admin/client/:code",
  adminAuth,
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
   ESTADO INDIVIDUAL DO CLIENTE
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

    if (client.active === false) {
      return res.status(403).json({
        ok: false,
        error: "cliente bloqueado"
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

    const data = await readData();

    const client =
      data.clients?.[clientCode];

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

    client.state = req.body || {};

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
      const data = await readData();

      res.json({
        ok: true,
        [key]: data[key] || {}
      });
    })
  );

  app.put(
    `/api/admin/${key}`,
    adminAuth,
    safe(async (req, res) => {
      const data = await readData();

      data[key] = req.body || {};

      await writeData(data);

      res.json({
        ok: true
      });
    })
  );
}

/* =========================================================
   ACERVO DE ÁUDIO ONLINE
   MÚSICAS / VINHETAS / FUNDOS / ANÚNCIOS
========================================================= */

const audioUpload = express.raw({
  type: [
    "audio/*",
    "application/octet-stream"
  ],
  limit: "60mb"
});

app.post(
  "/api/admin/media",
  adminAuth,
  audioUpload,
  safe(async (req, res) => {
    if (
      !Buffer.isBuffer(req.body) ||
      !req.body.length
    ) {
      return res.status(400).json({
        ok: false,
        error: "arquivo de áudio vazio"
      });
    }

    const kind = safeMediaKind(
      req.query.kind ||
      req.get("X-Media-Kind") ||
      "music"
    );

    const name = safeFileName(
      req.query.name ||
      req.get("X-File-Name") ||
      `audio-${Date.now()}.mp3`
    );

    const mimeType =
      String(
        req.get("Content-Type") ||
        "audio/mpeg"
      )
        .split(";")[0]
        .trim();

    const id = makeId(kind);

    await pool.query(
      `
      INSERT INTO capivara_media
      (
        id,
        kind,
        name,
        mime_type,
        size_bytes,
        file_data
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        id,
        kind,
        name,
        mimeType,
        req.body.length,
        req.body
      ]
    );

    res.json({
      ok: true,
      media: {
        id,
        kind,
        name,
        mimeType,
        size: req.body.length,
        url:
          `/api/media/${encodeURIComponent(id)}`
      }
    });
  })
);

app.get(
  "/api/media",
  safe(async (req, res) => {
    const kind =
      req.query.kind
        ? safeMediaKind(req.query.kind)
        : "";

    let result;

    if (kind) {
      result = await pool.query(
        `
        SELECT
          id,
          kind,
          name,
          mime_type,
          size_bytes,
          created_at
        FROM capivara_media
        WHERE kind = $1
        ORDER BY created_at DESC
        `,
        [kind]
      );
    } else {
      result = await pool.query(
        `
        SELECT
          id,
          kind,
          name,
          mime_type,
          size_bytes,
          created_at
        FROM capivara_media
        ORDER BY created_at DESC
        `
      );
    }

    res.json({
      ok: true,
      media: result.rows.map(row => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        mimeType: row.mime_type,
        size:
          Number(row.size_bytes || 0),
        createdAt: row.created_at,
        url:
          `/api/media/${encodeURIComponent(row.id)}`
      }))
    });
  })
);

app.get(
  "/api/media/:id",
  safe(async (req, res) => {
    const id =
      cleanMediaId(req.params.id);

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        mime_type,
        size_bytes,
        file_data
      FROM capivara_media
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const media = result.rows[0];

    if (!media) {
      return res.status(404).json({
        ok: false,
        error: "áudio não encontrado"
      });
    }

    const buffer = media.file_data;

    res.setHeader(
      "Content-Type",
      media.mime_type || "audio/mpeg"
    );

    res.setHeader(
      "Content-Length",
      buffer.length
    );

    res.setHeader(
      "Accept-Ranges",
      "bytes"
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=3600"
    );

    const range = req.headers.range;

    if (range) {
      const match =
        /bytes=(\d*)-(\d*)/.exec(range);

      if (match) {
        const start =
          match[1]
            ? Number(match[1])
            : 0;

        const end =
          match[2]
            ? Number(match[2])
            : buffer.length - 1;

        const safeStart =
          Math.max(
            0,
            Math.min(
              start,
              buffer.length - 1
            )
          );

        const safeEnd =
          Math.max(
            safeStart,
            Math.min(
              end,
              buffer.length - 1
            )
          );

        const chunk =
          buffer.subarray(
            safeStart,
            safeEnd + 1
          );

        res.status(206);

        res.setHeader(
          "Content-Range",
          `bytes ${safeStart}-${safeEnd}/${buffer.length}`
        );

        res.setHeader(
          "Content-Length",
          chunk.length
        );

        return res.end(chunk);
      }
    }

    res.end(buffer);
  })
);

app.delete(
  "/api/admin/media/:id",
  adminAuth,
  safe(async (req, res) => {
    const id =
      cleanMediaId(req.params.id);

    const result = await pool.query(
      `
      DELETE FROM capivara_media
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        ok: false,
        error: "áudio não encontrado"
      });
    }

    res.json({
      ok: true,
      id
    });
  })
);

app.get(
  "/api/admin/media/status",
  adminAuth,
  safe(async (req, res) => {
    const result = await pool.query(`
      SELECT
        kind,
        COUNT(*)::int AS total,
        COALESCE(SUM(size_bytes), 0)::bigint AS bytes
      FROM capivara_media
      GROUP BY kind
      ORDER BY kind
    `);

    const totalResult =
      await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(size_bytes), 0)::bigint AS bytes
        FROM capivara_media
      `);

    res.json({
      ok: true,
      total:
        totalResult.rows[0]?.total || 0,
      bytes:
        Number(
          totalResult.rows[0]?.bytes || 0
        ),
      categories:
        result.rows.map(row => ({
          kind: row.kind,
          total: row.total,
          bytes:
            Number(row.bytes || 0)
        }))
    });
  })
);

/* =========================================================
   GEMINI
========================================================= */

async function callGeminiWithFallback({
  prompt,
  model
}) {
  const data = await readData();
  const settings = data.settings || {};

  const keys =
    activeKeys(
      settings.apiPool?.text
    );

  if (
    keys.length === 0 &&
    process.env.GEMINI_API_KEY
  ) {
    keys.push(
      process.env.GEMINI_API_KEY
    );
  }

  if (!keys.length) {
    throw new Error(
      "nenhuma chave Gemini ativa"
    );
  }

  const requested =
    String(model || "").trim();

  const preferredModels = [
    requested,
    settings.geminiModel,
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ]
    .filter(Boolean)
    .map(v => String(v).trim());

  let lastError = null;

  for (
    let i = 0;
    i < keys.length;
    i++
  ) {
    let availableModels = [];

    try {
      const listResponse =
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
          {
            headers: {
              "x-goog-api-key": keys[i]
            }
          }
        );

      if (listResponse.ok) {
        const listJson =
          await listResponse.json();

        availableModels =
          (listJson.models || [])
            .filter(item => {
              const methods =
                item.supportedGenerationMethods ||
                item.supportedActions ||
                [];

              return (
                String(item.name || "")
                  .toLowerCase()
                  .includes("gemini") &&
                methods.includes(
                  "generateContent"
                )
              );
            })
            .map(item =>
              String(item.name || "")
                .replace(/^models\//, "")
            )
            .filter(Boolean);
      }
    } catch (error) {
      console.warn(
        "Não foi possível listar modelos Gemini:",
        error?.message || error
      );
    }

    let models = [];

    if (availableModels.length) {
      const preferredAvailable =
        preferredModels.filter(modelName =>
          availableModels.includes(
            modelName
          )
        );

      const stableFlash =
        availableModels.filter(name => {
          const n =
            name.toLowerCase();

          return (
            n.includes("flash") &&
            !n.includes("preview") &&
            !n.includes("experimental") &&
            !n.includes("exp")
          );
        });

      const stableOthers =
        availableModels.filter(name => {
          const n =
            name.toLowerCase();

          return (
            !n.includes("preview") &&
            !n.includes("experimental") &&
            !n.includes("exp")
          );
        });

      models = [
        ...new Set([
          ...preferredAvailable,
          ...stableFlash,
          ...stableOthers,
          ...availableModels
        ])
      ];
    } else {
      models = [
        ...new Set(
          preferredModels
        )
      ];
    }

    for (
      const currentModel of models
    ) {
      try {
        const url =
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          `${encodeURIComponent(currentModel)}:generateContent`;

        const ctrl =
          new AbortController();

        const timer =
          setTimeout(
            () => ctrl.abort(),
            15000
          );

        let response;

        try {
          response =
            await fetch(url, {
              method: "POST",
              signal: ctrl.signal,
              headers: {
                "Content-Type":
                  "application/json",
                "x-goog-api-key":
                  keys[i]
              },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        text: prompt
                      }
                    ]
                  }
                ],
                generationConfig: {
                  maxOutputTokens: 120
                }
              })
            });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          let detail = "";

          try {
            const body =
              await response.json();

            detail =
              body?.error?.message ||
              body?.message ||
              "";
          } catch {
            try {
              detail =
                await response.text();
            } catch {}
          }

          lastError =
            new Error(
              `Gemini chave ${i + 1} / ${currentModel}: HTTP ${response.status}` +
              (
                detail
                  ? ` — ${String(detail).slice(0, 220)}`
                  : ""
              )
            );

          continue;
        }

        const json =
          await response.json();

        const text =
          json?.candidates?.[0]
            ?.content?.parts
            ?.map(
              part =>
                part.text || ""
            )
            .join("")
            .trim();

        if (!text) {
          lastError =
            new Error(
              `Gemini chave ${i + 1} / ${currentModel}: resposta vazia`
            );

          continue;
        }

        return {
          text,
          keySlot: i + 1,
          model: currentModel
        };
      } catch (error) {
        lastError =
          error?.name ===
          "AbortError"
            ? new Error(
                `Gemini chave ${i + 1} / ${currentModel}: tempo esgotado`
              )
            : error;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "todas as chaves Gemini falharam"
    )
  );
}

app.post(
  "/api/ai/generate",
  safe(async (req, res) => {
    const body = req.body || {};

    const product =
      String(
        body.product || ""
      ).trim();

    const price =
      String(
        body.price || ""
      ).trim();

    const ramo =
      String(
        body.ramo || ""
      ).trim();

    const freeText =
      String(
        body.text ||
        body.brief ||
        ""
      ).trim();

    const model =
      String(
        body.model ||
        "gemini-2.5-flash"
      );

    const source =
      freeText ||
      [
        product &&
          `produto/serviço: ${product}`,

        price &&
          `preço informado: ${price}`,

        ramo &&
          `ramo apenas como contexto interno: ${ramo}`
      ]
        .filter(Boolean)
        .join("\n");

    if (!source) {
      return res.status(400).json({
        ok: false,
        error:
          "informe o que deseja anunciar"
      });
    }

    const prompt = `
Crie UMA frase curta de locução comercial para rádio.

Regras obrigatórias:
- máximo 150 caracteres
- escrever em português do Brasil
- usar letras minúsculas
- não usar a palavra "atenção"
- não usar dois-pontos
- não falar o ramo do estabelecimento
- não inventar preço
- não inventar promoção
- não inventar características do produto
- preservar exatamente a forma de venda/unidade informada
- não citar o nome do estabelecimento
- soar natural como uma locução real de rádio
- devolver somente a frase final, sem explicações

Informação do anúncio:
${source}
`.trim();

    try {
      const result =
        await callGeminiWithFallback({
          prompt,
          model
        });

      let text =
        String(result.text || "")
          .replace(
            /^[\"'“”]+|[\"'“”]+$/g,
            ""
          )
          .trim();

      if (text.length > 150) {
        text =
          text
            .slice(0, 150)
            .trim();
      }

      res.json({
        ok: true,
        text,
        provider: "gemini",
        keySlot: result.keySlot,
        model: result.model
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        error:
          error?.message ||
          "falha ao gerar texto"
      });
    }
  })
);

/* =========================================================
   ELEVENLABS
========================================================= */

async function callElevenLabsWithFallback({
  text,
  voiceId
}) {
  const data = await readData();
  const settings = data.settings || {};

  const keys =
    activeKeys(
      settings.apiPool?.voice
    );

  if (
    keys.length === 0 &&
    process.env.ELEVENLABS_API_KEY
  ) {
    keys.push(
      process.env.ELEVENLABS_API_KEY
    );
  }

  if (!keys.length) {
    throw new Error(
      "nenhuma chave ElevenLabs ativa"
    );
  }

  let lastError = null;

  for (
    let i = 0;
    i < keys.length;
    i++
  ) {
    try {
      const response =
        await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
          {
            method: "POST",
            headers: {
              "xi-api-key":
                keys[i],

              "Content-Type":
                "application/json",

              Accept:
                "audio/mpeg"
            },

            body: JSON.stringify({
              text,

              model_id:
                "eleven_multilingual_v2",

              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75
              }
            })
          }
        );

      if (!response.ok) {
        let detail = "";

        try {
          detail =
            await response.text();
        } catch {}

        lastError =
          new Error(
            `ElevenLabs chave ${i + 1}: HTTP ${response.status}` +
            (
              detail
                ? ` — ${String(detail).slice(0, 300)}`
                : ""
            )
          );

        continue;
      }

      return {
        buffer: Buffer.from(
          await response.arrayBuffer()
        ),
        keySlot: i + 1
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      "todas as chaves ElevenLabs falharam"
    )
  );
}

function getVoiceId(
  settings,
  type
) {
  const voices =
    settings.voices || {};

  const map = {
    adMale:
      voices.adMale ||
      process.env
        .ELEVENLABS_VOICE_MALE_ID,

    adFemale:
      voices.adFemale ||
      process.env
        .ELEVENLABS_VOICE_FEMALE_ID,

    jingleMale:
      voices.jingleMale ||
      process.env
        .ELEVENLABS_JINGLE_MALE_ID,

    jingleFemale:
      voices.jingleFemale ||
      process.env
        .ELEVENLABS_JINGLE_FEMALE_ID
  };

  return map[type] || "";
}

app.post(
  "/api/voice/generate",
  safe(async (req, res) => {
    const text =
      String(
        req.body?.text || ""
      ).trim();

    const voiceType =
      String(
        req.body?.voiceType ||
        "adMale"
      );

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "texto vazio"
      });
    }

    const data =
      await readData();

    const settings =
      data.settings || {};

    const voiceId =
      getVoiceId(
        settings,
        voiceType
      );

    if (!voiceId) {
      return res.status(400).json({
        ok: false,
        error:
          "voice ID não configurado"
      });
    }

    try {
      const result =
        await callElevenLabsWithFallback({
          text,
          voiceId
        });

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "X-Capivara-Key-Slot",
        String(result.keySlot)
      );

      res.send(result.buffer);
    } catch (error) {
      res.status(502).json({
        ok: false,
        error:
          error?.message ||
          "falha ao gerar áudio"
      });
    }
  })
);

/* =========================================================
   TESTE REAL DAS APIS
========================================================= */

app.get(
  "/api/test-apis",
  adminAuth,
  safe(async (req, res) => {
    const data =
      await readData();

    const settings =
      data.settings || {};

    const result = {
      ok: true,
      gemini: {
        ok: false
      },
      elevenlabs: {
        ok: false
      }
    };

    try {
      const gemini =
        await callGeminiWithFallback({
          prompt:
            "responda somente com a palavra ok",
          model:
            settings.geminiModel ||
            "gemini-2.5-flash"
        });

      result.gemini = {
        ok: true,
        keySlot:
          gemini.keySlot,
        model:
          gemini.model
      };
    } catch (error) {
      result.gemini = {
        ok: false,
        error:
          error?.message ||
          "falha Gemini"
      };
    }

    result.elevenlabs = {
      ok:
        activeKeys(
          settings.apiPool?.voice
        ).length > 0 ||
        !!process.env
          .ELEVENLABS_API_KEY,

      keys:
        activeKeys(
          settings.apiPool?.voice
        ).length ||
        (
          process.env
            .ELEVENLABS_API_KEY
            ? 1
            : 0
        ),

      voices: {
        adMale:
          !!getVoiceId(
            settings,
            "adMale"
          ),

        adFemale:
          !!getVoiceId(
            settings,
            "adFemale"
          ),

        jingleMale:
          !!getVoiceId(
            settings,
            "jingleMale"
          ),

        jingleFemale:
          !!getVoiceId(
            settings,
            "jingleFemale"
          )
      }
    };

    res.json(result);
  })
);

/* =========================================================
   TESTE DE VOZ ADM
========================================================= */

app.post(
  "/api/test-voice",
  adminAuth,
  safe(async (req, res) => {
    const data =
      await readData();

    const settings =
      data.settings || {};

    const voiceType =
      String(
        req.body?.voiceType ||
        "adMale"
      );

    const voiceId =
      req.body?.voiceId ||
      getVoiceId(
        settings,
        voiceType
      );

    if (!voiceId) {
      return res.status(400).json({
        ok: false,
        error:
          "voice ID não configurado"
      });
    }

    try {
      const result =
        await callElevenLabsWithFallback({
          text:
            req.body?.text ||
            "teste de voz capivara rádio",

          voiceId
        });

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "X-Capivara-Key-Slot",
        String(result.keySlot)
      );

      res.send(result.buffer);
    } catch (error) {
      res.status(502).json({
        ok: false,
        error:
          error?.message ||
          "falha no teste de voz"
      });
    }
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
      `Capivara Radio Server V3.2 ativo na porta ${PORT}`
    );
  }
);
