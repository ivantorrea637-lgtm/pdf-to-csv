import formidable from "formidable";
import fs from "fs";
import pdf from "pdf-parse";

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

function parseForm(req) {
  const form = formidable({
    multiples: true,
    keepExtensions: true,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeConcept(value) {
  const concept = String(value || "").replace(/\s+/g, " ").trim();
  if (!concept) return "";

  const upper = concept.toUpperCase();
  const excluded = EXCLUDED.some((name) => upper.includes(name));
  if (excluded) return "";

  return concept;
}

function extractRowsFromPdfText(rawText) {
  const text = cleanText(rawText);

  const invoiceRegex = /Invoice #\s*([A-Z0-9-]+)/gi;
  const matches = [...text.matchAll(invoiceRegex)];

  if (!matches.length) return [];

  const sections = matches.map((match, index) => {
    const start = match.index;
    const end = index < matches.length - 1 ? matches[index + 1].index : text.length;
    return text.slice(start, end);
  });

  const rows = sections.map((section) => {
    const factura =
      section.match(/Invoice #\s*([A-Z0-9-]+)/i)?.[1]?.trim() || "";

    const referencia =
      section.match(/P\.O\. No\.\s*([A-Z]{2}[A-Z0-9/.-]+)/i)?.[1]?.trim() ||
      section.match(/REF #\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i)?.[1]?.trim() ||
      "";

    const clienteRaw =
      section.match(/CLIENTE\s*:?\s*([^\n]+)/i)?.[1]?.trim() || "";

    const concepto = normalizeConcept(clienteRaw);

    let importe =
      section.match(/\$([0-9]+(?:\.[0-9]{2})?)/g)?.slice(-1)?.[0]?.replace("$", "") ||
      "";

    if (!importe) {
      importe =
        section.match(/Amount\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1]?.trim() || "";
    }

    return {
      factura,
      referencia: /^(PG|NL)/i.test(referencia) ? referencia : "",
      importe,
      concepto,
    };
  });

  return rows.filter(
    (row) => row.factura || row.referencia || row.importe || row.concepto
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido.",
    });
  }

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
        const buffer = fs.readFileSync(file.filepath);
        const data = await pdf(buffer);
        const rows = extractRowsFromPdfText(data.text);

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
          error: error.message || "Error al leer el PDF.",
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
