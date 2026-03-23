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
  "TOTAL",
  "DOLARES",
  "DOLLARS",
  "USD",
  "NUEVO LAREDO",
  "LAREDO TEXAS",
  "LAREDO, TEXAS",
  "CAJA",
  "PEDTO",
  "PEDIMENTO",
  "REFERENCIA",
  "REFERENCE",
  "ORIGEN",
  "DESTINO",
  "DESCRIPTION",
  "DESCRIPCION",
  "DESCRIPCIÓN",
];

const LEGAL_SUFFIXES = [
  "SA DE CV",
  "S DE RL DE CV",
  "SAPI DE CV",
  "S EN NC DE CV",
  "SC",
  "AC",
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

function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isExcludedConcept(value) {
  const upper = cleanLine(value).toUpperCase();
  if (!upper) return true;
  return EXCLUDED_CONCEPTS.some((item) => upper.includes(item));
}

function looksLikeCompanyOrPerson(value) {
  const text = cleanLine(value);
  if (!text) return false;

  const upper = text.toUpperCase();

  if (isExcludedConcept(text)) return false;

  if (LEGAL_SUFFIXES.some((suffix) => upper.includes(suffix))) return true;

  // Persona física: dos o más palabras con letras, evitando valores cortos o técnicos
  const words = text.split(" ").filter(Boolean);
  if (
    words.length >= 2 &&
    words.every((w) => /[A-ZÁÉÍÓÚÑ]/i.test(w)) &&
    !/\d/.test(text)
  ) {
    return true;
  }

  return false;
}

function normalizeConcept(value) {
  const text = cleanLine(value);
  if (!text) return "";
  if (!looksLikeCompanyOrPerson(text)) return "";
  return text;
}

function findFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanLine(match[1]);
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
    /\b([0-9]{4,8})\b/i,
  ]);
}

function findReference(section) {
  const matches = [
    ...section.matchAll(/\b(?:PG\d{5}\/\d{2}|NL\d{5})\b/gi),
  ].map((m) => cleanLine(m[0]));

  return matches[0] || "";
}

function findAmount(section) {
  const candidates = [];

  const moneyMatches = [...section.matchAll(/\$ ?([0-9]+(?:\.[0-9]{2})?)/g)];
  for (const match of moneyMatches) {
    const value = parseFloat(match[1]);
    if (!Number.isNaN(value) && value >= 50 && value <= 400) {
      candidates.push(match[1]);
    }
  }

  const plainMatches = [...section.matchAll(/\b([0-9]+(?:\.[0-9]{2})?)\b/g)];
  for (const match of plainMatches) {
    const value = parseFloat(match[1]);
    if (!Number.isNaN(value) && value >= 50 && value <= 400) {
      candidates.push(match[1]);
    }
  }

  if (!candidates.length) return "";

  return candidates[candidates.length - 1];
}

function extractConceptFromLabeledField(section) {
  const directCandidates = [
    findFirst(section, [/CLIENTE\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/CLIENT\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/CUSTOMER\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/CONCEPTO\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/DESCRIPTION\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/DESCRIPCION\s*:?\s*([^\n]+)/i]),
    findFirst(section, [/DESCRIPCIÓN\s*:?\s*([^\n]+)/i]),
  ];

  for (const candidate of directCandidates) {
    const concept = normalizeConcept(candidate);
    if (concept) return concept;
  }

  return "";
}

function extractConceptFromColumns(section) {
  const lines = cleanText(section)
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) =>
    /CLIENTE|CLIENT|CUSTOMER|CONCEPTO|DESCRIPTION|DESCRIPCION|DESCRIPCIÓN/i.test(line)
  );

  if (headerIndex === -1) return "";

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    let line = lines[i];

    if (/^TOTAL\b/i.test(line)) break;
    if (/^\$ ?[0-9]/.test(line)) continue;

    // intenta aislar razón social con sufijos legales
    const suffixMatch = line.match(
      /\b(.+?(?:SA DE CV|S DE RL DE CV|SAPI DE CV|S EN NC DE CV|SC|AC|INC|LLC|CORP|COMPANY))\b/i
    );
    if (suffixMatch?.[1]) {
      const concept = normalizeConcept(suffixMatch[1]);
      if (concept) return concept;
    }

    // limpiar pedazos operativos comunes
    line = line
      .replace(/\b(?:PG\d{5}\/\d{2}|NL\d{5})\b/gi, "")
      .replace(/\$ ?[0-9]+(?:\.[0-9]{2})?/g, "")
      .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "")
      .replace(/\b\d{4,}\b/g, "")
      .replace(
        /\b(ARRASTRE|CRUCE|FLETE|SERVICIO|MOVIMIENTO|ORIGEN|DESTINO|PEDTO|PEDIMENTO|CAJA|REF|REFERENCE)\b/gi,
        ""
      )
      .replace(/\s+/g, " ")
      .trim();

    const concept = normalizeConcept(line);
    if (concept) return concept;
  }

  return "";
}

function extractConcept(section) {
  return (
    extractConceptFromLabeledField(section) ||
    extractConceptFromColumns(section) ||
    ""
  );
}

function splitSections(text) {
  const cleaned = cleanText(text);

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
      referencia: /^(PG\d{5}\/\d{2}|NL\d{5})$/i.test(referencia)
        ? referencia
        : "",
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
