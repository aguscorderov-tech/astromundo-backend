# Astromundo — Backend

API real con persistencia en disco. Cero dependencias de npm: usa `node:http`
y `node:sqlite`, ambos nativos desde Node.js 22.5+. Esto significa que no hace
falta `npm install` ni configurar nada — se corre directo.

Probado end-to-end antes de entregarlo: registro, login, aislamiento entre
astrólogos (multi-tenant), y persistencia real de datos después de reiniciar
el proceso — no son promesas, se ejecutó de verdad.

## Correr en tu computadora

```
node server.js
```

Eso arranca el servidor en `http://localhost:3001` y crea el archivo
`astromundo.db` (la base de datos completa) en la misma carpeta la primera
vez que lo corrés. Para probarlo:

```
curl http://localhost:3001/api/health
```

## Endpoints

Todos los que no son `/api/auth/*` necesitan el header
`Authorization: Bearer <token>` (el token lo devuelve `/api/auth/login` o
`/api/auth/register`).

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/auth/register` | Crea la cuenta de un astrólogo |
| POST | `/api/auth/login` | Devuelve un token de sesión |
| GET | `/api/auth/me` | Perfil del astrólogo autenticado |
| GET/POST | `/api/clients` | Listar / crear clientes |
| PUT | `/api/clients/:id` | Editar un cliente |
| GET/POST | `/api/charts` | Listar / guardar cartas (el cálculo lo hace el frontend) |
| GET | `/api/charts/:id` | Una carta puntual |
| PUT | `/api/charts/:id/interpretation` | Guardar el texto de interpretación IA |
| GET/POST | `/api/services` | Catálogo de servicios del astrólogo |
| PUT/DELETE | `/api/services/:id` | Editar / borrar un servicio |
| POST | `/api/services/:id/toggle` | Pausar / activar |
| GET/POST | `/api/appointments` | Turnos de agenda |
| PUT | `/api/appointments/:id` | Editar un turno |
| GET/POST | `/api/payments` | Movimientos de pago |
| GET | `/api/payments/summary` | Totales del mes |

## Multi-tenant

Cada astrólogo solo ve sus propios datos — está verificado con una prueba
real: se creó una segunda cuenta y se confirmó que ve una lista de clientes
vacía aunque la primera cuenta ya tenía clientes cargados.

## Desplegarlo en un servidor real (para que funcione desde internet)

**Recomendado: Railway** — a diferencia de Render (que no permite disco
persistente en su plan gratuito, así que SQLite perdería todo en cada
redeploy), Railway sí soporta un volumen persistente real incluso en uso
chico sin pagar.

1. **Subí `astromundo-backend/` a un repositorio de GitHub** (si nunca lo
   hiciste: creá un repo nuevo en github.com, y desde esta carpeta corré
   `git init && git add . && git commit -m "backend" && git remote add
   origin <URL-del-repo> && git push -u origin main`).
2. Entrá a **railway.app** → "New Project" → "Deploy from GitHub repo" →
   elegí el repositorio. Railway detecta que es Node.js solo (por el
   `package.json`) y arranca con `node server.js` automáticamente — ya
   quedó configurado en `railway.json`.
3. **Agregá el volumen persistente** (el paso que no hay que saltear):
   en el servicio ya creado → pestaña "Settings" → "Volumes" → "New
   Volume" → montalo en `/data`.
4. En la pestaña "Variables" del servicio, agregá:
   ```
   DB_PATH=/data/astromundo.db
   ```
   Esto le dice al backend que guarde la base de datos DENTRO del volumen
   persistente en vez de al lado del código (que se borra en cada deploy).
5. Railway te da una URL pública del tipo
   `https://astromundo-backend-production.up.railway.app`. Probala:
   ```
   curl https://tu-url.up.railway.app/api/health
   ```
   Debería devolver `{"ok":true,"service":"astromundo-backend"}`.

## Después de desplegar el backend: conectar el frontend

1. Abrí `astromundo/index.html` y cambiá esta línea (está cerca del
   principio, marcada con ⚠️):
   ```html
   window.ASTROMUNDO_API_URL = "http://localhost:3001/api";
   ```
   por tu URL real de Railway + `/api`:
   ```html
   window.ASTROMUNDO_API_URL = "https://tu-url.up.railway.app/api";
   ```
2. Publicá la carpeta `astromundo/` en Netlify Drop (mismo procedimiento
   que ya usamos antes: arrastrar la carpeta a app.netlify.com/drop).
3. Entrá a la URL que te da Netlify, creá una cuenta desde el login que
   armamos, y probá el flujo completo — si algo no conecta, lo primero
   a revisar es la consola del navegador (F12 → Console): ahí se ve
   cualquier error de red o de CORS.


## Conectar el frontend

Hoy `astromundo/services/*.js` (el frontend) sigue guardando todo en arrays
en memoria — no le pega a esta API todavía. Conectar los dos es el siguiente
paso natural: cada función de `services/` (`createClient`, `getCharts`, etc.)
pasaría de mutar un array a hacer un `fetch()` a estos endpoints. Como la
capa de componentes (`/components`) solo habla con `/services`, ese cambio
no debería tocar ni un componente visual.
