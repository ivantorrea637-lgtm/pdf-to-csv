import formidable from "formidable";
import fs from "fs";
import pdf from "pdf-parse";

export const config = {
  api: {
    bodyParser: false,
  },
};

const EXCLUDED_CONCEPTS = [
  "PG NEXUS",
  "PG INTERNATIONAL",
  "PG DISTRIBUTION",
  "PALOS GARZA FORWARDING",
  "PALOS GARZA FW",
  "CRUCE",
  "IMPORTACION",
  "EXPORTACION",
  "ARRASTRE",
  "FLETE",
  "SERVICIO",
  "MOVIMIENTO",
  "NUEVO LAREDO",
  "LAREDO TEXAS",
  "LAREDO, TEXAS",
  "TOTAL",
  "DOLARES",
  "DOLLAR",
];

const LEGAL_SUFFIXES = [
  "SA DE CV",
  "S DE RL DE CV",
  "SAPI DE CV",
  "S EN NC DE CV",
  "INC",
  "LLC",
  "CORP",
  "COMPANY",
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
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  const upper = text.toUpperCase();

  if (EXCLUDED_CONCEPTS.some((bad) => upper.includes(bad))) return "";

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

function findInvoice(section) {
  return findFirst(section, [
    /Invoice\s*#\s*([A-Z0-9-]+)/i,
    /Invoice\s*No\.?\s*([A-Z0-9-]+)/i,
    /INVOICE\s*#\s*([A-Z0-9-]+)/i,
    /INVOICE\s*NO\.?\s*([A-Z0-9-]+)/i,
    /Factura\s*#\s*([A-Z0-9-]+)/i,
    /Factura\s*No\.?\s*([A-Z0-9-]+)/i,
    /FACTURA\s*#\s*([A-Z0-9-]+)/i,
    /FACTURA\s*NO\.?\s*([A-Z0-9-]+)/i,
    /\b(PI ?-?\d{3,6})\b/i,
    /\b(PG\d{2}-\d{3,6})\b/i,
  ]);
}

function findReference(section) {
  const candidates = [
    ...section.matchAll(/\b(?:PG|NL)[A-Z0-9/-]{4,}\b/gi),
  ].map((m) => m[0].trim());

  return candidates[0] || "";
}

function findAmount(section) {
  const moneyMatches = [...section.matchAll(/\$ ?([0-9]+(?:\.[0-9]{2})?)/g)].map(
    (m) => m[1]
  );

  if (moneyMatches.length) {
    return moneyMatches[moneyMatches.length - 1];
  }

  return findFirst(section, [
    /Amount\s*:?\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /Total\s*:?\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /Importe\s*:?\s*([0-9]+(?:\.[0-9]{2})?)/i,
  ]);
}

function looksLikeLegalEntity(text) {
  const upper = text.toUpperCase();
  return LEGAL_SUFFIXES.some((suffix) => upper.includes(suffix));
}

function extractConceptFromLabeledField(section) {
  const direct = [
    findFirst(section, [/CLIENTE\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/CLIENT\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/CUSTOMER\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/CONCEPTO\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/DESCRIPCION\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/DESCRIPCIÓN\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/DESCRIPTION\s*:?\s*([^\n]+)/i]),
  ]
    .map(normalizeConcept)
    .filter(Boolean);

  if (direct.length) return direct[0];
  return "";
}

function extractConceptFromPIStyle(section) {
  const lines = cleanText(section)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) =>
    /CLIENTE|CLIENT|CUSTOMER/i.test(line)
  );

  if (headerIndex === -1) return "";

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];

    if (/TOTAL/i.test(line)) break;
    if (!/\$ ?[0-9]+(?:\.[0-9]{2})?/.test(line)) continue;

    // Quitar fecha, caja, referencia, pedimento y monto
    let candidate = line
      .replace(/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s+/, "") // fecha
      .replace(/^[A-Z0-9-]+\s+/, "") // caja
      .replace(/^(PG|NL)[A-Z0-9/-]+\s+/i, "") // referencia
      .replace(/^[A-Z0-9-]+\s+/, "") // pedimento
      .replace(/\$ ?[0-9]+(?:\.[0-9]{2})?.*$/i, "") // monto al final
      .trim();

    // Si trae razón social con sufijo legal, cortar hasta el sufijo
    const suffixRegex =
      /\b(.+?(?:SA DE CV|S DE RL DE CV|SAPI DE CV|S EN NC DE CV|INC|LLC|CORP|COMPANY))\b/i;

    const suffixMatch = candidate.match(suffixRegex);
    if (suffixMatch?.[1]) {
      return normalizeConcept(suffixMatch[1]);
    }

    // Como fallback, cortar antes de términos operativos típicos
    candidate = candidate
      .replace(/\b(ARRASTRE|CRUCE|FLETE|SERVICIO|MOVIMIENTO|ORIGEN|DESTINO)\b.*$/i, "")
      .trim();

    candidate = normalizeConcept(candidate);
    if (candidate) return candidate;
  }

  return "";
}

function extractConceptFrom7248Style(section) {
  const lines = cleanText(section)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Busca la línea entre la ruta y el TOTAL
  const totalIndex = lines.findIndex((line) => /^TOTAL/i.test(line));

  if (totalIndex === -1) return "";

  for (let i = totalIndex - 1; i >= 0; i -= 1) {
    const line = lines[i];

    if (!line) continue;
    if (/NUEVO LAREDO|LAREDO TEXAS|LAREDO, TEXAS/i.test(line)) continue;
    if (/CRUCE|IMPORTACION|EXPORTACION|DESCRIPCION|DESCRIPCIÓN|TOTAL|DOLARES|REMISION/i.test(line))
      continue;

    const concept = normalizeConcept(line);
    if (concept) return concept;
  }

  return "";
}

function extractConcept(section) {
  return (
    extractConceptFromLabeledField(section) ||
    extractConceptFromPIStyle(section) ||
    extractConceptFrom7248Style(section) ||
    ""
  );
}

function splitSections(text) {
  const cleaned = cleanText(text);

  // Formato 4777: varias facturas por "Invoice #"
  const invoiceMatches = [
    ...cleaned.matchAll(
      /(Invoice\s*#|Invoice\s*No\.?|INVOICE\s*#|INVOICE\s*NO\.?|Factura\s*#|Factura\s*No\.?|FACTURA\s*#|FACTURA\s*NO\.?)\s*[A-Z0-9-]+/gi
    ),
  ];

  if (invoiceMatches.length > 1) {
    return invoiceMatches.map((match, index) => {
      const start = match.index;
      const end =
        index < invoiceMatches.length - 1 ? invoiceMatches[index + 1].index : cleaned.length;
      return cleaned.slice(start, end);
    });
  }

  // Formato 7248: páginas repetidas por nombre del emisor
  const sandraMatches = [...cleaned.matchAll(/SANDRA CECILIA ROMERO LOREDO/gi)];
  if (sandraMatches.length > 1) {
    return sandraMatches.map((match, index) => {
      const start = match.index;
      const end =
        index < sandraMatches.length - 1 ? sandraMatches[index + 1].index : cleaned.length;
      return cleaned.slice(start, end);
    });
  }

  return [cleaned];
}

function extractRowsFromPdfText(rawText) {
  const text = cleanText(rawText);
  const sections = splitSections(text);

  const rows = sections.map((section) => {
    const factura = findInvoice(section);
    const referencia = findReference(section);
    const importe = findAmount(section);
    const concepto = extractConcept(section);

    return {
      factura,
      referencia: /^(PG|NL)/i.test(referencia) ? referencia : "",
      importe,
      concepto,
    };
  });

  return rows.filter((row) => row.factura || row.referencia || row.importe || row.concepto);
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
