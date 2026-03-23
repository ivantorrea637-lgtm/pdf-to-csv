import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const EXCLUDED = [
  "PG NEXUS",
  "PG INTERNATIONAL",
  "PG DISTRIBUTION",
  "PALOS GARZA FORWARDING",
];

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => ({
    factura: String(row?.factura || "").trim(),
    referencia: String(row?.referencia || "").trim(),
    importe: String(row?.importe || "").replace(/[$,\s]/g, "").trim(),
    concepto: String(row?.concepto || "").trim(),
  }));
}

function extractJsonArray(text) {
  const clean = String(text || "").replace(/```json|```/gi, "").trim();

  try {
    return normalizeRows(JSON.parse(clean));
  } catch {
    const start = clean.indexOf("[");
    const end = clean.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      return normalizeRows(JSON.parse(clean.slice(start, end + 1)));
    }
    throw new Error("La respuesta no vino en JSON válido.");
  }
}

function parseForm(req) {
  const form = formidable({ multiples: true, keepExtensions: true });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function uploadPdfToOpenAI(client, filePath) {
  return await client.files.create({
    file: fs.createReadStream(filePath),
    purpose: "user_data",
  });
}

async function extractWithOpenAI(client, fileId, fileName) {
  const prompt = `Analiza este PDF de facturas.

IMPORTANTE:
- Cada página contiene UNA factura.
- Debes leer cada página por separado.
- Extrae una fila por cada página.

Devuelve un array JSON con este formato exacto:
[
  {
    "factura": "19681",
    "referencia": "PG14490/26",
    "importe": "125.00",
    "concepto": "SUKARNE SA DE CV"
  }
]

Qué extraer:
- factura: el número que aparece después de "Invoice #"
- referencia: el valor de "P.O. No." o "REF #"
- importe: el monto final de Amount o Total, sin signo $
- concepto: el valor del campo "CLIENTE"

Reglas:
- si referencia no empieza con PG o NL, déjala vacía
- concepto debe ser empresa o nombre propio
- ignora estos nombres como concepto: ${EXCLUDED.join(", ")}

Responde SOLO con JSON válido.
No expliques nada.
No uses markdown.
No uses texto adicional.

Nombre del archivo: ${fileName}`;

  const response = await client.responses.create({
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            file_id: fileId,
          },
          {
            type: "input_text",
            text: prompt,
          },
        ],
      },
    ],
    reasoning: { effort: "medium" },
    max_output_tokens: 2200,
  });

  console.log("OPENAI OUTPUT:", response.output_text || "");

  return extractJsonArray(response.output_text || "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido.",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Falta configurar OPENAI_API_KEY en Vercel.",
    });
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const { files } = await parseForm(req);
    let uploadedFiles = files.files || [];

    if (!Array.isArray(uploadedFiles)) {
      uploadedFiles = [uploadedFiles];
    }

    if (!uploadedFiles.length) {
      return res.status(400).json({
        ok: false,
        error: "No se recibieron archivos PDF.",
      });
    }

    const allRows = [];
    const details = [];

    for (const file of uploadedFiles) {
      if (!file.mimetype || file.mimetype !== "application/pdf") {
        details.push({
          file: file.originalFilename || "archivo",
          ok: false,
          error: "Archivo no válido. Solo PDF.",
        });
        continue;
      }

      try {
        const uploaded = await uploadPdfToOpenAI(client, file.filepath);
        const rows = await extractWithOpenAI(
          client,
          uploaded.id,
          file.originalFilename
        );

        allRows.push(...rows);
        details.push({
          file: file.originalFilename,
          ok: true,
          rows: rows.length,
        });
      } catch (error) {
        details.push({
          file: file.originalFilename || "archivo",
          ok: false,
          error: error.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      rows: allRows,
      details,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Error interno del servidor.",
    });
  }
}
