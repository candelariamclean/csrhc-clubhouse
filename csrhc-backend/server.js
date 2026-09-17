const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── AUTENTICACIÓN DEL ADMIN ───────────────────────────────────────────────────
// Usuario y contraseña vienen de variables de entorno (ADMIN_USER, ADMIN_PASS)
function requireAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  // Si no se configuraron credenciales, se bloquea el acceso por seguridad
  if (!user || !pass) {
    return res.status(503).send('Admin no configurado. Falta definir ADMIN_USER y ADMIN_PASS.');
  }
  const header = req.headers.authorization || '';
  const [tipo, credenciales] = header.split(' ');
  if (tipo === 'Basic' && credenciales) {
    const [u, p] = Buffer.from(credenciales, 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Panel Admin CSRHC"');
  return res.status(401).send('Acceso restringido. Ingresá tus credenciales.');
}

// Proteger admin.html incluso si lo piden directo
app.get(['/admin.html','/public/admin.html'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
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
      CREATE TABLE IF NOT EXISTS arboles (
        id             INT PRIMARY KEY,
        estado         VARCHAR(20) NOT NULL DEFAULT 'disponible',
        nombre         VARCHAR(120),
        whatsapp       VARCHAR(40),
        email          VARCHAR(120),
        nombre_publico VARCHAR(120),
        monto          INT DEFAULT 0,
        fecha          DATETIME
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS aportantes (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        clave        VARCHAR(160) NOT NULL UNIQUE,
        nombre       VARCHAR(120),
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
    // Seed de árboles (17 fijos)
    const [ar] = await conn.query('SELECT COUNT(*) AS n FROM arboles');
    if (ar[0].n === 0) {
      const arboles = [];
      for (let k = 0; k < 17; k++) arboles.push([k]);
      await conn.query('INSERT INTO arboles (id) VALUES ?', [arboles]);
      console.log('✅ 17 árboles cargados por defecto');
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
    const [[v]]  = await pool.query("SELECT COUNT(*) AS n FROM lotes WHERE estado='vendido'");
    const [[r]]  = await pool.query("SELECT COUNT(*) AS n FROM lotes WHERE estado='reservado'");
    const [[m]]  = await pool.query("SELECT COALESCE(SUM(valor),0) AS s FROM lotes WHERE estado='vendido'");
    const [[ap]] = await pool.query('SELECT COUNT(*) AS n FROM aportantes');
    // Valor total de TODOS los lotes (base) + monto de árboles vendidos
    const [[baseLotes]] = await pool.query('SELECT COALESCE(SUM(valor),0) AS s FROM lotes');
    const [[arbVendidos]] = await pool.query("SELECT COALESCE(SUM(monto),0) AS s, COUNT(*) AS n FROM arboles WHERE estado='vendido'");
    const montoArboles = Number(arbVendidos.s) || 0;
    const montoLotes = Number(m.s) || 0;
    const baseLotesN = Number(baseLotes.s) || 0;
    const baseTotal = baseLotesN + montoArboles;           // total sobre el que se calcula el %
    const recaudado = montoLotes + montoArboles;           // recaudado real (lotes vendidos + árboles)
    res.json({ total: t.n, adoptados: v.n, vendidos: v.n, reservados: r.n,
               disponibles: t.n - v.n - r.n,
               monto: recaudado, monto_lotes: montoLotes, monto_arboles: montoArboles,
               base_total: baseTotal, arboles_vendidos: arbVendidos.n,
               porcentaje: baseTotal > 0 ? Math.round((recaudado / baseTotal) * 100) : 0,
               aportantes: ap.n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /lotes/init — compat: el frontend puede llamarlo, pero el seed ya corre solo
app.post('/lotes/init', async (req, res) => {
  res.json({ ok: true, nota: 'Los lotes se cargan automáticamente al iniciar el servidor.' });
});

// POST /lotes/:id/adoptar → crea una RESERVA (queda pendiente de confirmación)
app.post('/lotes/:id/adoptar', async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, email, nombre_publico, cuotas } = req.body;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                       return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado === 'vendido')   return res.status(400).json({ error: 'Lote ya vendido' });
    if (lote.estado === 'reservado') return res.status(400).json({ error: 'Lote ya reservado' });
    if (!nombre)                     return res.status(400).json({ error: 'Nombre requerido' });

    const valor = PRECIOS[lote.zona] || lote.valor;
    // Queda RESERVADO: bloquea el lote pero todavía no suma al recaudado ni al ranking
    await conn.query(
      `UPDATE lotes SET estado='reservado', valor=?, nombre=?, whatsapp=?, email=?, nombre_publico=?, cuotas=?, fecha=?
       WHERE id=?`,
      [valor, nombre, whatsapp || null, email || null, nombre_publico || nombre, cuotas || null, now(), id]
    );
    const [[updated]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    res.json({ ok: true, lote: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// POST /lotes/:id/registrar → ALTA MANUAL desde admin (queda VENDIDO directo)
app.post('/lotes/:id/registrar', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, email, nombre_publico, cuotas } = req.body;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                     return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado === 'vendido') return res.status(400).json({ error: 'Lote ya vendido' });
    if (!nombre)                   return res.status(400).json({ error: 'Nombre requerido' });

    const valor = PRECIOS[lote.zona] || lote.valor;
    const nompub = nombre_publico || nombre;
    await conn.query(
      `UPDATE lotes SET estado='vendido', valor=?, nombre=?, whatsapp=?, email=?, nombre_publico=?, cuotas=?, fecha=?
       WHERE id=?`,
      [valor, nombre, whatsapp || null, email || null, nompub, cuotas || null, now(), id]
    );

    // Suma al aportante agrupando por email
    const clave = (email && email.trim()) ? email.trim().toLowerCase() : ('lote:' + id);
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE clave=?', [clave]);
    if (ap) {
      await conn.query('UPDATE aportantes SET monto_total=monto_total+?, lotes_count=lotes_count+1 WHERE clave=?',
        [valor, clave]);
    } else {
      await conn.query('INSERT INTO aportantes (clave, nombre, whatsapp, email, monto_total, lotes_count, fecha) VALUES (?,?,?,?,?,1,?)',
        [clave, nompub, whatsapp || null, email || null, valor, now()]);
    }

    const [[updated]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    res.json({ ok: true, lote: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// POST /lotes/:id/confirmar → RESERVADO se vuelve VENDIDO (suma al recaudado/ranking)
app.post('/lotes/:id/confirmar', requireAuth, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                        return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado !== 'reservado')  return res.status(400).json({ error: 'El lote no está reservado' });

    await conn.query("UPDATE lotes SET estado='vendido' WHERE id=?", [id]);

    // Suma al aportante, agrupando por EMAIL (si no hay email, cuenta individual por lote)
    const nompub = lote.nombre_publico || lote.nombre;
    const clave = (lote.email && lote.email.trim()) ? lote.email.trim().toLowerCase() : ('lote:' + lote.id);
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE clave=?', [clave]);
    if (ap) {
      await conn.query('UPDATE aportantes SET monto_total=monto_total+?, lotes_count=lotes_count+1 WHERE clave=?',
        [lote.valor, clave]);
    } else {
      await conn.query('INSERT INTO aportantes (clave, nombre, whatsapp, email, monto_total, lotes_count, fecha) VALUES (?,?,?,?,?,1,?)',
        [clave, nompub, lote.whatsapp || null, lote.email || null, lote.valor, now()]);
    }

    const [[updated]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    res.json({ ok: true, lote: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// POST /lotes/:id/rechazar → RESERVADO vuelve a DISPONIBLE
app.post('/lotes/:id/rechazar', requireAuth, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                        return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado !== 'reservado')  return res.status(400).json({ error: 'El lote no está reservado' });

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

// DELETE /lotes/:id/adoptar — liberar
app.delete('/lotes/:id/adoptar', requireAuth, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [[lote]] = await conn.query('SELECT * FROM lotes WHERE id=?', [id]);
    if (!lote)                      return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.estado !== 'vendido') return res.status(400).json({ error: 'Lote no está vendido' });

    const clave = (lote.email && lote.email.trim()) ? lote.email.trim().toLowerCase() : ('lote:' + lote.id);
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE clave=?', [clave]);
    if (ap) {
      if (ap.lotes_count <= 1) {
        await conn.query('DELETE FROM aportantes WHERE clave=?', [clave]);
      } else {
        await conn.query('UPDATE aportantes SET monto_total=monto_total-?, lotes_count=lotes_count-1 WHERE clave=?',
          [lote.valor, clave]);
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

// ── ÁRBOLES (aportes extraordinarios) ─────────────────────────────────────────

// GET /arboles — lista de árboles
app.get('/arboles', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM arboles ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /arboles/:id/cargar — cargar aporte extraordinario (admin, monto manual)
app.post('/arboles/:id/cargar', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, email, monto, nombre_publico } = req.body;
  const conn = await pool.getConnection();
  try {
    const [[arbol]] = await conn.query('SELECT * FROM arboles WHERE id=?', [id]);
    if (!arbol)                    return res.status(404).json({ error: 'Árbol no encontrado' });
    if (arbol.estado === 'vendido')return res.status(400).json({ error: 'Árbol ya asignado' });
    if (!nombre)                   return res.status(400).json({ error: 'Nombre requerido' });
    const montoNum = parseInt(monto, 10);
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'Monto inválido' });

    const nompub = nombre_publico || 'Anónimo';
    await conn.query(
      "UPDATE arboles SET estado='vendido', nombre=?, whatsapp=?, email=?, nombre_publico=?, monto=?, fecha=? WHERE id=?",
      [nombre, whatsapp || null, email || null, nompub, montoNum, now(), id]
    );

    // Suma al aportante agrupando por email (si no hay, cuenta individual por árbol)
    const clave = (email && email.trim()) ? email.trim().toLowerCase() : ('arbol:' + id);
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE clave=?', [clave]);
    if (ap) {
      await conn.query('UPDATE aportantes SET monto_total=monto_total+? WHERE clave=?', [montoNum, clave]);
    } else {
      await conn.query('INSERT INTO aportantes (clave, nombre, whatsapp, email, monto_total, lotes_count, fecha) VALUES (?,?,?,?,?,0,?)',
        [clave, nompub, whatsapp || null, email || null, montoNum, now()]);
    }

    const [[updated]] = await conn.query('SELECT * FROM arboles WHERE id=?', [id]);
    res.json({ ok: true, arbol: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// POST /arboles/:id/liberar — liberar árbol (admin)
app.post('/arboles/:id/liberar', requireAuth, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [[arbol]] = await conn.query('SELECT * FROM arboles WHERE id=?', [id]);
    if (!arbol)                     return res.status(404).json({ error: 'Árbol no encontrado' });
    if (arbol.estado !== 'vendido') return res.status(400).json({ error: 'El árbol no está asignado' });

    // Revertir del aportante (por nombre público)
    const clave = (arbol.email && arbol.email.trim()) ? arbol.email.trim().toLowerCase() : ('arbol:' + id);
    const [[ap]] = await conn.query('SELECT * FROM aportantes WHERE clave=?', [clave]);
    if (ap) {
      const nuevoMonto = ap.monto_total - arbol.monto;
      if (nuevoMonto <= 0 && ap.lotes_count <= 0) {
        await conn.query('DELETE FROM aportantes WHERE clave=?', [clave]);
      } else {
        await conn.query('UPDATE aportantes SET monto_total=monto_total-? WHERE clave=?', [arbol.monto, clave]);
      }
    }
    await conn.query(
      "UPDATE arboles SET estado='disponible', nombre=NULL, whatsapp=NULL, email=NULL, monto=0, fecha=NULL WHERE id=?", [id]
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
app.get('/admin', requireAuth, (req, res) => {
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
