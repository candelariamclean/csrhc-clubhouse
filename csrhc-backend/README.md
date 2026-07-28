# CSRHC Backend — Nuevo Club House

Backend Node.js + SQLite para gestionar los lotes de la campaña.

## Instalación

```bash
cd csrhc-backend
npm install
npm start
```

El servidor corre en http://localhost:3000
El panel admin en http://localhost:3000/admin

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /lotes | Todos los lotes |
| GET | /lotes/stats | Resumen (adoptados, monto, etc) |
| POST | /lotes/init | Carga inicial de lotes desde el frontend |
| POST | /lotes/:id/adoptar | Registrar adopción |
| DELETE | /lotes/:id/adoptar | Liberar lote |
| GET | /aportantes | Ranking de aportantes |
| GET | /admin | Panel de administración |

## Conectar el frontend

En `CSRHC_v7.html` cambiá esta línea con la URL donde corre el backend:

```js
const API_URL = 'http://localhost:3000'; // ← tu URL acá
```

## Deploy en Railway (gratis)

1. Creá cuenta en https://railway.app
2. New Project → Deploy from GitHub repo
3. Subí la carpeta csrhc-backend como repo separado
4. Railway te da una URL — ponela en API_URL del frontend
