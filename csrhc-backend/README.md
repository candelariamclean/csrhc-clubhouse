# CSRHC Backend — Nuevo Club House (MySQL)

Backend Node.js + Express + MySQL para gestionar los lotes de la campaña.

## Desplegar en Hostinger (plan Business)

### 1. Crear la base de datos MySQL
En el hPanel: **Databases → MySQL Databases → Create Database**
Anotá: nombre de base, usuario, contraseña y host (normalmente `localhost`).

### 2. Agregar el sitio Node.js
En el hPanel: **Websites → Add Website → Node.js Apps → Import Git Repository**
- Autorizá GitHub y elegí el repo `csrhc-clubhouse`
- Framework: **Express.js** (o "Other" con entry file `server.js`)
- Carpeta raíz: `csrhc-backend`

### 3. Configurar variables de entorno
En el panel del sitio Node.js, sección **Environment Variables**, cargá:

| Variable | Valor |
|----------|-------|
| DB_HOST | localhost |
| DB_USER | (tu usuario MySQL) |
| DB_PASSWORD | (tu contraseña MySQL) |
| DB_DATABASE | (nombre de tu base) |
| DB_PORT | 3306 |

### 4. Deploy
Click en **Deploy**. Al iniciar, el servidor crea las tablas y carga los 400 lotes automáticamente.

### 5. Conectar el frontend
En `CSRHC_v7.html`, cambiá la línea:
```js
const API_URL = 'http://localhost:3000';
```
por la URL de tu backend en Hostinger (ej: `https://tudominio.com` o el subdominio que te asigne).

## Endpoints
- `GET /lotes` — todos los lotes
- `GET /lotes/stats` — resumen
- `POST /lotes/:id/adoptar` — registrar adopción
- `DELETE /lotes/:id/adoptar` — liberar lote
- `GET /aportantes` — ranking
- `GET /admin` — panel de administración
