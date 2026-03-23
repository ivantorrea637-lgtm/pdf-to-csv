export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    rows: [
      {
        factura: "PRUEBA",
        referencia: "PG000",
        importe: "125",
        concepto: "DEMO"
      }
    ]
  });
}
