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
  if (EXCLUDED.some((name) => upper.includes(name))) return "";

  return concept;
}

function findFirst(section, patterns) {
  for (const pattern of patterns) {
    const match = section.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractRowsFromPdfText(rawText) {
  const text = cleanText(rawText);

  const invoiceMatches = [
    ...text.matchAll(
      /(Invoice #|Invoice No\.?|INVOICE #|INVOICE NO\.?|Factura #|Factura No\.?)\s*([A-Z0-9-]+)/gi
    ),
  ];

  // Si encuentra varias facturas, corta por secciones
  if (invoiceMatches.length > 0) {
    const sections = invoiceMatches.map((match, index) => {
      const start = match.index;
      const end =
        index < invoiceMatches.length - 1 ? invoiceMatches[index + 1].index : text.length;
      return text.slice(start, end);
    });

    const rows = sections.map((section) => {
      const factura = findFirst(section, [
        /Invoice #\s*([A-Z0-9-]+)/i,
        /Invoice No\.?\s*([A-Z0-9-]+)/i,
        /INVOICE #\s*([A-Z0-9-]+)/i,
        /INVOICE NO\.?\s*([A-Z0-9-]+)/i,
        /Factura #\s*([A-Z0-9-]+)/i,
        /Factura No\.?\s*([A-Z0-9-]+)/i,
      ]);

      const referencia = findFirst(section, [
        /P\.O\. No\.?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
        /PO No\.?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
        /REF #\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
        /REFERENCE\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
        /REFERENCIA\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
      ]);

      const clienteRaw = findFirst(section, [
        /CLIENTE\s*:?\s*([^\n]+)/i,
        /CLIENT\s*:?\s*([^\n]+)/i,
        /CUSTOMER\s*:?\s*([^\n]+)/i,
        /RAZON SOCIAL\s*:?\s*([^\n]+)/i,
      ]);

      const concepto = normalizeConcept(clienteRaw);

      let importe = "";

      const moneyMatches = [...section.matchAll(/\$ ?([0-9]+(?:\.[0-9]{2})?)/g)];
      if (moneyMatches.length) {
        importe = moneyMatches[moneyMatches.length - 1][1];
      }

      if (!importe) {
        importe = findFirst(section, [
          /Amount\s*([0-9]+(?:\.[0-9]{2})?)/i,
          /Total\s*([0-9]+(?:\.[0-9]{2})?)/i,
          /Importe\s*([0-9]+(?:\.[0-9]{2})?)/i,
        ]);
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

  // Si no detecta varias facturas, intenta sacar una sola
  const singleRow = {
    factura: findFirst(text, [
      /Invoice #\s*([A-Z0-9-]+)/i,
      /Invoice No\.?\s*([A-Z0-9-]+)/i,
      /INVOICE #\s*([A-Z0-9-]+)/i,
      /INVOICE NO\.?\s*([A-Z0-9-]+)/i,
      /Factura #\s*([A-Z0-9-]+)/i,
      /Factura No\.?\s*([A-Z0-9-]+)/i,
    ]),
    referencia: "",
    importe: "",
    concepto: "",
  };

  const ref = findFirst(text, [
    /P\.O\. No\.?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
    /PO No\.?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
    /REF #\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
    /REFERENCE\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
    /REFERENCIA\s*:?\s*([A-Z]{2}[A-Z0-9/.-]+)/i,
  ]);

  singleRow.referencia = /^(PG|NL)/i.test(ref) ? ref : "";

  singleRow.concepto = normalizeConcept(
    findFirst(text, [
      /CLIENTE\s*:?\s*([^\n]+)/i,
      /CLIENT\s*:?\s*([^\n]+)/i,
      /CUSTOMER\s*:?\s*([^\n]+)/i,
      /RAZON SOCIAL\s*:?\s*([^\n]+)/i,
    ])
  );

  const moneyMatches = [...text.matchAll(/\$ ?([0-9]+(?:\.[0-9]{2})?)/g)];
  if (moneyMatches.length) {
    singleRow.importe = moneyMatches[moneyMatches.length - 1][1];
  } else {
    singleRow.importe = findFirst(text, [
      /Amount\s*([0-9]+(?:\.[0-9]{2})?)/i,
      /Total\s*([0-9]+(?:\.[0-9]{2})?)/i,
      /Importe\s*([0-9]+(?:\.[0-9]{2})?)/i,
    ]);
  }

  if (
    singleRow.factura ||
    singleRow.referencia ||
    singleRow.importe ||
    singleRow.concepto
  ) {
    return [singleRow];
  }

  return [];
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
          preview: cleanText(rawText).slice(0, 400),
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
