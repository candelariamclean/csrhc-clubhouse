const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONEXIÓN MySQL ───────────────────────────────────────────────────────────
// Las credenciales vienen de variables de entorno (se configuran en Hostinger).
// Nunca se escriben directo en el código.
const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port:     process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const PRECIOS = { premium: 1500000, media: 750000, economica: 450000 };
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ── INIT: crear tablas y cargar los 400 lotes si hace falta ───────────────────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lotes (
        id              VARCHAR(32) PRIMARY KEY,
        zona            VARCHAR(20) NOT NULL,
        valor           INT NOT NULL DEFAULT 1000,
        estado          VARCHAR(20) NOT NULL DEFAULT 'disponible',
        nombre          VARCHAR(120),
        whatsapp        VARCHAR(40),
        email           VARCHAR(120),
        nombre_publico  VARCHAR(120),
        cuotas          INT,
        fecha           DATETIME
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS aportantes (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        nombre       VARCHAR(120) NOT NULL UNIQUE,
        whatsapp     VARCHAR(40),
        email        VARCHAR(120),
        monto_total  INT DEFAULT 0,
        lotes_count  INT DEFAULT 0,
        fecha        DATETIME
      )
    `);

    // Seed: cargar los 400 lotes si la tabla está vacía
    const [rows] = await conn.query('SELECT COUNT(*) AS n FROM lotes');
    if (rows[0].n === 0) {
      const zonaDe = i => (i < 15 ? 'premium' : i < 25 ? 'media' : 'economica');
      const values = [];
      for (let j = 0; j < 10; j++)
        for (let i = 0; i < 40; i++) {
          const zona = zonaDe(i);
          values.push([`lote_${i}_${j}`, zona, PRECIOS[zona]]);
        }
      await conn.query('INSERT INTO lotes (id, zona, valor) VALUES ?', [values]);
      console.log('✅ 400 lotes cargados por defecto');
    }
  } finally {
    conn.release();
  }
}

// ── LOTES ────────────────────────────────────────────────────────────────────

app.get('/lotes', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM lotes');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/lotes/stats', async (req, res) => {
  try {
    const [[t]]  = await pool.query('SELECT COUNT(*) AS n FROM lotes');
    const [[a]]  = await pool.query("SELECT COUNT(*) AS n FROM lotes WHERE estado='adoptado'");
    const [[m]]  = await pool.query("SELECT COALESCE(SUM(valor),0) AS s FROM lotes WHERE estado='adoptado'");
    const [[ap]] = await pool.query('SELECT COUNT(*) AS n FROM aportantes');
    res.json({ total: t.n, adoptados: a.n, disponibles: t.n - a.n, monto: m.s, aportantes: ap.n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /lotes/init — compat: el frontend puede llamarlo, pero el seed ya corre solo
app.post('/lotes/init', async (req, res) => {
  res.json({ ok: true, nota: 'Los lotes se cargan automáticamente al iniciar el servidor.' });
});

// POST /lotes/:id/adoptar
app.post('/lotes/:id/adoptar', async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, email, nombre_publico, cuotas } = req.body;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                      return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado === 'adoptado') return res.status(400).json({ error: 'Lote ya adoptado' });
    if (!nombre)                    return res.status(400).json({ error: 'Nombre requerido' });

    const valor = PRECIOS[lote.zona] || lote.valor;
    await conn.query(
      `UPDATE lotes SET estado='adoptado', valor=?, nombre=?, whatsapp=?, email=?, nombre_publico=?, cuotas=?, fecha=?
       WHERE id=?`,
      [valor, nombre, whatsapp || null, email || null, nombre_publico || nombre, cuotas || null, now(), id]
    );

    const nompub = nombre_publico || nombre;
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE nombre=?', [nompub]);
    if (ap) {
      await conn.query('UPDATE aportantes SET monto_total=monto_total+?, lotes_count=lotes_count+1 WHERE nombre=?',
        [valor, nompub]);
    } else {
      await conn.query('INSERT INTO aportantes (nombre, whatsapp, email, monto_total, lotes_count, fecha) VALUES (?,?,?,?,1,?)',
        [nompub, whatsapp || null, email || null, valor, now()]);
    }

    const [[updated]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    res.json({ ok: true, lote: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// DELETE /lotes/:id/adoptar — liberar
app.delete('/lotes/:id/adoptar', async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                      return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado !== 'adoptado') return res.status(400).json({ error: 'Lote no está adoptado' });

    const nompub = lote.nombre_publico || lote.nombre;
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE nombre=?', [nompub]);
    if (ap) {
      if (ap.lotes_count <= 1) {
        await conn.query('DELETE FROM aportantes WHERE nombre=?', [nompub]);
      } else {
        await conn.query('UPDATE aportantes SET monto_total=monto_total-?, lotes_count=lotes_count-1 WHERE nombre=?',
          [lote.valor, nompub]);
      }
    }

    await conn.query(
      `UPDATE lotes SET estado='disponible', nombre=NULL, whatsapp=NULL, email=NULL,
       nombre_publico=NULL, cuotas=NULL, fecha=NULL WHERE id=?`, [id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ── APORTANTES ───────────────────────────────────────────────────────────────
app.get('/aportantes', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM aportantes ORDER BY monto_total DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PANEL ADMIN ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ CSRHC Backend (MySQL) corriendo en puerto ${PORT}`);
      console.log(`📋 Panel admin: /admin`);
    });
  })
  .catch(err => {
    console.error('❌ Error inicializando la base de datos:', err.message);
    process.exit(1);
  });
