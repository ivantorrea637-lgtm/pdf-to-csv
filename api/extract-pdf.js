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
  "ARRASTRE",
  "CRUCE",
  "FLETE",
  "SERVICIO",
  "MOVIMIENTO LOCAL",
  "CRUCE DE IMPORTACION",
  "CRUCE DE EXPORTACION",
  "IMPORTACION",
  "EXPORTACION",
  "TRANSFER",
  "TRASLADO",
  "CAJA",
  "PEDTO",
  "REFERENCIA",
  "REFERENCE",
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

function isExcludedConcept(value) {
  const upper = String(value || "").toUpperCase().trim();
  if (!upper) return true;
  return EXCLUDED.some((word) => upper.includes(word));
}

function looksLikeCompanyOrPerson(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  const upper = text.toUpperCase();

  if (isExcludedConcept(text)) return false;

  // Razones sociales comunes
  const companyHints = [
    "SA DE CV",
    "S DE RL DE CV",
    "SAPI DE CV",
    "S. DE R.L. DE C.V.",
    "INC",
    "LLC",
    "CORP",
    "COMPANY",
    "CORPORATION",
    "LOGISTICS",
    "TRANSPORT",
    "TRUCKING",
  ];

  if (companyHints.some((hint) => upper.includes(hint))) return true;

  // Nombre propio: al menos 2 palabras con letras
  const words = text.split(" ").filter(Boolean);
  if (words.length >= 2 && words.every((w) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(w))) {
    return true;
  }

  return false;
}

function normalizeConcept(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (!looksLikeCompanyOrPerson(text)) return "";
  return text;
}

function findFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function findBestReference(text) {
  const matches = [
    ...text.matchAll(/\b(PG|NL)[A-Z0-9/-]*\b/gi),
  ].map((m) => m[0].trim());

  return matches[0] || "";
}

function findBestInvoice(text) {
  return findFirst(text, [
    /Invoice\s*#\s*([A-Z0-9-]+)/i,
    /Invoice\s*No\.?\s*([A-Z0-9-]+)/i,
    /INVOICE\s*#\s*([A-Z0-9-]+)/i,
    /INVOICE\s*NO\.?\s*([A-Z0-9-]+)/i,
    /Factura\s*#\s*([A-Z0-9-]+)/i,
    /Factura\s*No\.?\s*([A-Z0-9-]+)/i,
    /FACTURA\s*#\s*([A-Z0-9-]+)/i,
    /FACTURA\s*NO\.?\s*([A-Z0-9-]+)/i,
  ]);
}

function findBestAmount(text) {
  const matches = [
    ...text.matchAll(/\$ ?([0-9]+(?:\.[0-9]{2})?)/g),
  ].map((m) => m[1]);

  if (matches.length) {
    return matches[matches.length - 1];
  }

  const alt = findFirst(text, [
    /Amount\s*:?\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /Total\s*:?\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /Importe\s*:?\s*([0-9]+(?:\.[0-9]{2})?)/i,
  ]);

  return alt || "";
}

function findBestConcept(text) {
  const direct = [
    findFirst(text, [/CLIENTE\s*:?\s*([^\n]+)/i]),
    findFirst(text, [/CLIENT\s*:?\s*([^\n]+)/i]),
    findFirst(text, [/CUSTOMER\s*:?\s*([^\n]+)/i]),
    findFirst(text, [/RAZON SOCIAL\s*:?\s*([^\n]+)/i]),
    findFirst(text, [/CONCEPTO\s*:?\s*([^\n]+)/i]),
    findFirst(text, [/DESCRIPCION\s*:?\s*([^\n]+)/i]),
    findFirst(text, [/DESCRIPTION\s*:?\s*([^\n]+)/i]),
  ].map(normalizeConcept).filter(Boolean);

  if (direct.length) return direct[0];

  // Buscar líneas candidatas
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    const cleaned = line
      .replace(/^CLIENTE\s*:?\s*/i, "")
      .replace(/^CLIENT\s*:?\s*/i, "")
      .replace(/^CUSTOMER\s*:?\s*/i, "")
      .replace(/^RAZON SOCIAL\s*:?\s*/i, "")
      .trim();

    const concept = normalizeConcept(cleaned);
    if (concept) return concept;
  }

  return "";
}

function splitSections(text) {
  const invoiceMatches = [
    ...text.matchAll(
      /(Invoice\s*#|Invoice\s*No\.?|INVOICE\s*#|INVOICE\s*NO\.?|Factura\s*#|Factura\s*No\.?|FACTURA\s*#|FACTURA\s*NO\.?)\s*[A-Z0-9-]+/gi
    ),
  ];

  if (!invoiceMatches.length) {
    return [text];
  }

  return invoiceMatches.map((match, index) => {
    const start = match.index;
    const end = index < invoiceMatches.length - 1 ? invoiceMatches[index + 1].index : text.length;
    return text.slice(start, end);
  });
}

function extractRowsFromPdfText(rawText) {
  const text = cleanText(rawText);
  const sections = splitSections(text);

  const rows = sections.map((section) => {
    const factura = findBestInvoice(section);
    const referencia = findBestReference(section);
    const importe = findBestAmount(section);
    const concepto = findBestConcept(section);

    return {
      factura,
      referencia: /^(PG|NL)/i.test(referencia) ? referencia : "",
      importe,
      concepto,
    };
  });

  return rows.filter((row) =>
    row.factura || row.referencia || row.importe || row.concepto
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
        const rawText = data.text || "";
        const rows = extractRowsFromPdfText(rawText);

        allRows.push(...rows);

        details.push({
          file: file.originalFilename,
          ok: true,
          rows: rows.length,
          preview: cleanText(rawText).slice(0, 500),
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
