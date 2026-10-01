# iframe-wall

Una página con iframes de **cualquier dominio**, todos servidos desde un mismo origen para poder leer
el DOM de cada iframe (`iframe.contentDocument`) sin chocar con la same-origin policy ni con
`X-Frame-Options` / CSP.

Funciona como un proxy inverso con prefijo en la ruta. Sin dependencias, solo Node.

## Uso

```sh
node server.js
# abrir http://127.0.0.1:8080/__wall/
```

Variables de entorno:

| Variable | Default     | Descripción                                                              |
|----------|-------------|--------------------------------------------------------------------------|
| `PORT`   | `8080`      | Puerto del servidor                                                      |
| `HOST`   | `127.0.0.1` | Interfaz donde escucha                                                   |
| `TARGET` | _(vacío)_   | Fallback opcional (ej. `http://localhost:3001`) para rutas sin prefijo   |

Los iframes se definen en `FRAMES` dentro de `public/index.html`, o en vivo con el formulario de la página.

## Rutas

| Ruta                          | Destino                                              |
|-------------------------------|------------------------------------------------------|
| `/__wall/...`                 | Archivos de `public/` (la página con iframes)        |
| `/__p/<host>/<path>`          | `https://<host>/<path>`                              |
| `/__p/http:<host>/<path>`     | `http://<host>/<path>` (HTTP plano, apps locales)    |
| cualquier otra                | Se enruta por el `Referer`; si no hay, a `TARGET`    |

## Qué hace el proxy

- Elimina `X-Frame-Options`, CSP (y report-only), COOP, COEP, CORP y HSTS.
- Reescribe `Location` de los redirects para que no se escapen del proxy.
- Cookies: quita `Domain`, `Secure` y `SameSite`; `Path=/`.
- HTML: reescribe `src`, `href`, `action`, `formaction`, `poster`, `data-src`; quita `<meta>` CSP;
  inyecta un shim que redirige `fetch`, `XHR`, `WebSocket` y `window.open` por el proxy.
- Túnel de WebSockets (con TLS para destinos HTTPS).
- Los iframes llevan `sandbox` sin `allow-top-navigation`, lo que frena el frame-busting.

## Límites

- Las SPAs que leen `location.pathname` ven `/__p/host/...` y sus routers pueden fallar.
- Las cookies de todos los dominios comparten el origen `localhost` y pueden colisionar por nombre.
- No se reescribe `srcset`, atributos sin comillas ni HTML en charsets distintos de UTF-8.
- Sitios con anti-bot (Google, Cloudflare con challenge) pueden seguir bloqueando.

## Seguridad

Es un proxy abierto pensado para **desarrollo local**. Escucha solo en `127.0.0.1` y no debe exponerse
a una red ni a internet.
