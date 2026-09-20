async function callGeminiWithFallback({ prompt, model }) {
  const data = await readData();
  const settings = data.settings || {};

  const keys = activeKeys(settings.apiPool?.text);

  if (
    keys.length === 0 &&
    process.env.GEMINI_API_KEY
  ) {
    keys.push(process.env.GEMINI_API_KEY);
  }

  if (!keys.length) {
    throw new Error("nenhuma chave Gemini ativa");
  }

  let lastError = null;

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const apiKey = keys[keyIndex];

    try {
      /* ==========================================
         1. PERGUNTA AO GOOGLE QUAIS MODELOS
            ESTA CHAVE REALMENTE PODE USAR
      ========================================== */

      const listResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        {
          method: "GET",
          headers: {
            "x-goog-api-key": apiKey
          }
        }
      );

      const listRaw = await listResponse.text();

      let listJson = {};

      try {
        listJson = listRaw
          ? JSON.parse(listRaw)
          : {};
      } catch {
        listJson = {};
      }

      if (!listResponse.ok) {
        const detail =
          listJson?.error?.message ||
          listRaw ||
          `HTTP ${listResponse.status}`;

        lastError = new Error(
          `Gemini chave ${keyIndex + 1}: HTTP ${listResponse.status} - ${detail}`
        );

        console.warn(lastError.message);

        // passa automaticamente para a próxima chave
        continue;
      }

      /* ==========================================
         2. PEGA SOMENTE MODELOS QUE SUPORTAM
            generateContent
      ========================================== */

      const availableModels = Array.isArray(listJson.models)
        ? listJson.models
        : [];

      let usableModels = availableModels
        .filter(item => {
          const methods =
            item?.supportedGenerationMethods || [];

          return methods.includes("generateContent");
        })
        .map(item => {
          /*
            Google devolve:
            models/gemini-xxxx

            O endpoint de geração também aceita
            exatamente esse recurso.
          */
          return String(item?.name || "").trim();
        })
        .filter(Boolean);

      /*
        Preferimos modelos Gemini de texto.
        Evita escolher modelos de embedding,
        imagem etc.
      */

      usableModels = usableModels.filter(name =>
        name.toLowerCase().includes("gemini")
      );

      if (!usableModels.length) {
        lastError = new Error(
          `Gemini chave ${keyIndex + 1}: nenhum modelo com generateContent disponível`
        );

        console.warn(lastError.message);
        continue;
      }

      /* ==========================================
         3. ORGANIZA PREFERÊNCIA

         Se o modelo pedido pelo Player/ADM existir
         para ESTA chave, ele vai primeiro.

         Depois preferimos modelos Flash disponíveis.

         Não inventamos nenhum nome.
      ========================================== */

      const requestedModel = String(
        model ||
        settings.geminiModel ||
        ""
      )
        .trim()
        .replace(/^models\//, "");

      usableModels.sort((a, b) => {
        const cleanA =
          a.replace(/^models\//, "");

        const cleanB =
          b.replace(/^models\//, "");

        if (
          requestedModel &&
          cleanA === requestedModel
        ) {
          return -1;
        }

        if (
          requestedModel &&
          cleanB === requestedModel
        ) {
          return 1;
        }

        const aFlash =
          cleanA.toLowerCase().includes("flash");

        const bFlash =
          cleanB.toLowerCase().includes("flash");

        if (aFlash && !bFlash) return -1;
        if (!aFlash && bFlash) return 1;

        /*
          Evita experimental/preview quando há
          opção normal disponível.
        */

        const aPreview =
          /preview|exp|experimental/i.test(cleanA);

        const bPreview =
          /preview|exp|experimental/i.test(cleanB);

        if (!aPreview && bPreview) return -1;
        if (aPreview && !bPreview) return 1;

        return 0;
      });

      /* ==========================================
         4. TESTA SOMENTE MODELOS QUE O PRÓPRIO
            GOOGLE DISSE ESTAREM DISPONÍVEIS
      ========================================== */

      for (const modelResource of usableModels) {
        try {
          const cleanModel =
            modelResource.replace(/^models\//, "");

          const url =
            "https://generativelanguage.googleapis.com/v1beta/models/" +
            encodeURIComponent(cleanModel) +
            ":generateContent";

          const response = await fetch(url, {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },

            body: JSON.stringify({
              contents: [
                {
                  role: "user",
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

          const raw = await response.text();

          let json = {};

          try {
            json = raw
              ? JSON.parse(raw)
              : {};
          } catch {
            json = {};
          }

          if (!response.ok) {
            const detail =
              json?.error?.message ||
              raw ||
              `HTTP ${response.status}`;

            lastError = new Error(
              `Gemini chave ${keyIndex + 1}, modelo ${cleanModel}: HTTP ${response.status} - ${detail}`
            );

            console.warn(lastError.message);

            /*
              Se este modelo não funcionar,
              simplesmente testa o próximo que
              o próprio Google listou.
            */
            continue;
          }

          const text = json
            ?.candidates?.[0]
            ?.content?.parts
            ?.map(part => part?.text || "")
            .join("")
            .trim();

          if (!text) {
            lastError = new Error(
              `Gemini chave ${keyIndex + 1}, modelo ${cleanModel}: resposta vazia`
            );

            console.warn(lastError.message);
            continue;
          }

          console.log(
            `Gemini OK | chave ${keyIndex + 1} | modelo ${cleanModel}`
          );

          return {
            text,
            keySlot: keyIndex + 1,
            model: cleanModel
          };

        } catch (error) {
          lastError = error;

          console.error(
            "Erro ao testar modelo Gemini:",
            error?.message || error
          );
        }
      }

    } catch (error) {
      lastError = error;

      console.error(
        `Erro Gemini chave ${keyIndex + 1}:`,
        error?.message || error
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "nenhuma chave/modelo Gemini conseguiu gerar o anúncio"
    )
  );
}
