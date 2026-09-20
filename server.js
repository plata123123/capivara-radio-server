async function callGeminiWithFallback({
  prompt,
  model
}) {
  const data = await readData();
  const settings = data.settings || {};

  const keys = activeKeys(
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

  /*
    CORREÇÃO GEMINI 404

    Ordem:
    1. tenta o modelo pedido pelo Player
    2. tenta o modelo configurado no ADM
    3. tenta automaticamente modelos de fallback

    Se um modelo não existir para aquela chave/API e retornar
    400 ou 404, o servidor passa para o próximo modelo.
  */

  const models = [
    model,
    settings.geminiModel,
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ]
    .map(value =>
      String(value || "").trim()
    )
    .filter(
      (value, index, array) =>
        value &&
        array.indexOf(value) === index
    );

  let lastError = null;

  for (
    let keyIndex = 0;
    keyIndex < keys.length;
    keyIndex++
  ) {

    const apiKey = keys[keyIndex];

    for (
      let modelIndex = 0;
      modelIndex < models.length;
      modelIndex++
    ) {

      const currentModel =
        models[modelIndex];

      try {

        const url =
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(currentModel) +
          ":generateContent";

        const response =
          await fetch(
            url,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                /*
                  A chave agora vai no header oficial
                  recomendado pela API Gemini.
                */
                "x-goog-api-key":
                  apiKey
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
            }
          );

        /*
          Lemos a resposta mesmo quando ocorre erro.
          Assim o servidor consegue identificar
          corretamente 400, 404, 429 etc.
        */

        const raw =
          await response.text();

        let json = {};

        try {
          json =
            raw
              ? JSON.parse(raw)
              : {};
        } catch {
          json = {};
        }

        /*
          MODELO / REQUISIÇÃO NÃO DISPONÍVEL

          400 ou 404:
          não derruba a geração.
          tenta automaticamente o próximo modelo.
        */

        if (!response.ok) {

          const detail =
            json?.error?.message ||
            raw ||
            `HTTP ${response.status}`;

          lastError =
            new Error(
              `Gemini chave ${
                keyIndex + 1
              }, modelo ${
                currentModel
              }: HTTP ${
                response.status
              } - ${detail}`
            );

          console.warn(
            lastError.message
          );

          if (
            response.status === 400 ||
            response.status === 404
          ) {

            console.log(
              `Tentando próximo modelo Gemini...`
            );

            continue;
          }

          /*
            Problema de chave, limite ou servidor:
            401
            403
            429
            5xx

            Nesse caso passa para a próxima chave.
          */

          break;
        }

        /*
          RESPOSTA GEMINI
        */

        const text =
          json
            ?.candidates?.[0]
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
              `Gemini chave ${
                keyIndex + 1
              }, modelo ${
                currentModel
              }: resposta vazia`
            );

          console.warn(
            lastError.message
          );

          continue;
        }

        /*
          SUCESSO
        */

        console.log(
          `Gemini OK | chave ${
            keyIndex + 1
          } | modelo ${currentModel}`
        );

        return {
          text,
          keySlot:
            keyIndex + 1,

          model:
            currentModel
        };

      } catch (error) {

        lastError =
          error;

        console.error(
          "Erro Gemini:",
          error?.message ||
          error
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "todas as chaves/modelos Gemini falharam"
    )
  );
}
