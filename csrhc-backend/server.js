const express  = require('express');
const Database = require('better-sqlite3');
const cors     = require('cors');
const path     = require('path');

const app = express();
const db  = new Database(path.join(__dirname, 'lotes.db'));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── INIT TABLAS ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS lotes (
    id              TEXT PRIMARY KEY,
    zona            TEXT    NOT NULL,
    valor           INTEGER NOT NULL DEFAULT 1000,
    estado          TEXT    NOT NULL DEFAULT 'disponible',
    nombre          TEXT,
    whatsapp        TEXT,
    email           TEXT,
    nombre_publico  TEXT,
    cuotas          INTEGER,
    fecha           TEXT
  );

  CREATE TABLE IF NOT EXISTS aportantes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT    NOT NULL UNIQUE,
    whatsapp     TEXT,
    email        TEXT,
    monto_total  INTEGER DEFAULT 0,
    lotes_count  INTEGER DEFAULT 0,
    fecha        TEXT
  );
`);

const PRECIOS = { premium:1500000, media:750000, economica:450000 };
const now = () => new Date().toISOString();

// ── SEED: cargar los 400 lotes por defecto si la tabla está vacía ─────────────
// Grilla 40×10: columnas 0-14 = Dorado, 15-24 = Azul, 25-39 = Rojo
(function seedLotes() {
  const n = db.prepare('SELECT COUNT(*) as n FROM lotes').get().n;
  if (n > 0) return;
  const zonaDe = i => (i < 15 ? 'premium' : i < 25 ? 'media' : 'economica');
  const insert = db.prepare('INSERT INTO lotes (id, zona, valor) VALUES (?,?,?)');
  const seed = db.transaction(() => {
    for (let j = 0; j < 10; j++)
      for (let i = 0; i < 40; i++) {
        const zona = zonaDe(i);
        insert.run(`lote_${i}_${j}`, zona, PRECIOS[zona]);
      }
  });
  seed();
  console.log('✅ 400 lotes cargados por defecto');
})();

// ── LOTES ────────────────────────────────────────────────────────────────────

// GET /lotes — todos los lotes
app.get('/lotes', (req, res) => {
  res.json(db.prepare('SELECT * FROM lotes').all());
});

// GET /lotes/stats — resumen
app.get('/lotes/stats', (req, res) => {
  const total     = db.prepare('SELECT COUNT(*) as n FROM lotes').get().n;
  const adoptados = db.prepare("SELECT COUNT(*) as n FROM lotes WHERE estado='adoptado'").get().n;
  const monto     = db.prepare("SELECT COALESCE(SUM(valor),0) as s FROM lotes WHERE estado='adoptado'").get().s;
  const aportantes= db.prepare('SELECT COUNT(*) as n FROM aportantes').get().n;
  res.json({ total, adoptados, disponibles: total - adoptados, monto, aportantes });
});

// POST /lotes/init — carga masiva desde el frontend (solo inserta los que no existen)
app.post('/lotes/init', (req, res) => {
  const { lotes } = req.body;
  if (!lotes) return res.status(400).json({ error: 'Falta campo lotes' });
  const insert = db.prepare('INSERT OR IGNORE INTO lotes (id, zona, valor) VALUES (?,?,?)');
  const run = db.transaction(items => {
    for (const [id, data] of Object.entries(items))
      insert.run(id, data.zona, data.valor);
  });
  run(lotes);
  res.json({ ok: true, insertados: Object.keys(lotes).length });
});

// POST /lotes/:id/adoptar — registrar adopción
app.post('/lotes/:id/adoptar', (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, email, nombre_publico } = req.body;

  const lote = db.prepare('SELECT * FROM lotes WHERE id=?').get(id);
  if (!lote)                    return res.status(404).json({ error: 'Lote no encontrado' });
  if (lote.estado === 'adoptado') return res.status(400).json({ error: 'Lote ya adoptado' });
  if (!nombre)                  return res.status(400).json({ error: 'Nombre requerido' });

  const valorZona = PRECIOS[lote.zona] || lote.valor;
  db.prepare(`UPDATE lotes
    SET estado='adoptado', valor=?, nombre=?, whatsapp=?, email=?, nombre_publico=?, cuotas=?, fecha=?
    WHERE id=?`
  ).run(valorZona, nombre, whatsapp||null, email||null, nombre_publico||nombre, req.body.cuotas||null, now(), id);
  lote.valor = valorZona;

  const nompub = nombre_publico || nombre;
  const ap = db.prepare('SELECT * FROM aportantes WHERE nombre=?').get(nompub);
  if (ap) {
    db.prepare('UPDATE aportantes SET monto_total=monto_total+?, lotes_count=lotes_count+1 WHERE nombre=?')
      .run(lote.valor, nompub);
  } else {
    db.prepare('INSERT INTO aportantes (nombre, whatsapp, email, monto_total, lotes_count, fecha) VALUES (?,?,?,?,1,?)')
      .run(nompub, whatsapp||null, email||null, lote.valor, now());
  }

  res.json({ ok: true, lote: db.prepare('SELECT * FROM lotes WHERE id=?').get(id) });
});

// DELETE /lotes/:id/adoptar — liberar lote (baja)
app.delete('/lotes/:id/adoptar', (req, res) => {
  const { id } = req.params;
  const lote = db.prepare('SELECT * FROM lotes WHERE id=?').get(id);
  if (!lote)                       return res.status(404).json({ error: 'Lote no encontrado' });
  if (lote.estado !== 'adoptado')  return res.status(400).json({ error: 'Lote no está adoptado' });

  const nompub = lote.nombre_publico || lote.nombre;
  const ap = db.prepare('SELECT * FROM aportantes WHERE nombre=?').get(nompub);
  if (ap) {
    if (ap.lotes_count <= 1) {
      db.prepare('DELETE FROM aportantes WHERE nombre=?').run(nompub);
    } else {
      db.prepare('UPDATE aportantes SET monto_total=monto_total-?, lotes_count=lotes_count-1 WHERE nombre=?')
        .run(lote.valor, nompub);
    }
  }

  db.prepare(`UPDATE lotes
    SET estado='disponible', nombre=NULL, whatsapp=NULL, email=NULL, nombre_publico=NULL, fecha=NULL
    WHERE id=?`).run(id);

  res.json({ ok: true });
});

// ── APORTANTES ───────────────────────────────────────────────────────────────

// GET /aportantes — ranking completo
app.get('/aportantes', (req, res) => {
  res.json(db.prepare('SELECT * FROM aportantes ORDER BY monto_total DESC').all());
});

// ── PANEL ADMIN ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ CSRHC Backend corriendo en http://localhost:${PORT}`);
  console.log(`📋 Panel admin: http://localhost:${PORT}/admin`);
});
