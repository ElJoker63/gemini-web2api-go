# gemini-web2api-go

**De la web de Gemini a una API compatible con OpenAI y Gemini.** Un proxy autohospedado que convierte la aplicación web gratuita [gemini.google.com](https://gemini.google.com) en endpoints estándar `/v1/chat/completions`, `/v1/models`, `/v1/responses` y `/v1beta` — **sin necesidad de API Key oficial de Google ni cuotas de pago**. Binario único en Go, huella TLS real de Chrome 146, pool de cookies con renovación automática de tokens, pool de proxies, panel de administración web integrado en español/inglés/chino, soporte de SQLite, MySQL y PostgreSQL. Incluye soporte para generación de imágenes, música, canvas y video (`/v1/videos`).

<img src="docs/banner.svg" alt="gemini-web2api-go — Gemini web a API compatible con OpenAI, API nativa de Gemini y MCP" width="100%">

[![Release](https://img.shields.io/github/v/release/ElJoker63/gemini-web2api-go?label=release)](https://github.com/ElJoker63/gemini-web2api-go/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ElJoker63/gemini-web2api-go/total?label=downloads)](https://github.com/ElJoker63/gemini-web2api-go/releases)
[![Stars](https://img.shields.io/github/stars/ElJoker63/gemini-web2api-go?style=flat&label=stars)](https://github.com/ElJoker63/gemini-web2api-go/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/go-1.21%2B-00ADD8.svg)](https://golang.org)
[![Docker](https://img.shields.io/badge/docker-distroless-blue)](Dockerfile)

[中文](README.md) | [English](README_EN.md) | Español

> Repositorio oficial: **[github.com/ElJoker63/gemini-web2api-go](https://github.com/ElJoker63/gemini-web2api-go)** — lanzamientos, issues y documentación.

Convierte la web de Google Gemini en una API compatible con OpenAI, ofreciendo en el mismo puerto la API nativa de Gemini y herramientas MCP. **Binario único**, **sin cuenta obligatoria** (funciona en modo anónimo), **huella TLS real de Chrome**, bases de datos **SQLite / MySQL / PostgreSQL**, y panel de administración web incluido.

---

## Índice

- [Características principales](#características-principales)
- [Inicio rápido](#inicio-rápido)
  - [Opción 1: Binario precompilado (Recomendado)](#opción-1-binario-precompilado-recomendado)
  - [Opción 2: Docker / Docker Compose](#opción-2-docker--docker-compose)
- [Auto-actualización](#auto-actualización)
- [Conexión con clientes](#conexión-con-clientes)
- [API Keys y cuentas exclusivas](#api-keys-y-cuentas-exclusivas)
- [Modelos soportados](#modelos-soportados)
- [Pool de Cookies](#pool-de-cookies)
- [Pool de Proxies](#pool-de-proxies)
- [Opciones de configuración (CLI y config.json)](#opciones-de-configuración-cli-y-configjson)
- [Licencia](#licencia)

---

## Características principales

- **Totalmente compatible con OpenAI:** `/v1/chat/completions`, `/v1/models`, `/v1/responses`. Funciona con cualquier cliente estándar (OpenAI SDK, LangChain, LlamaIndex, Chatbox, NextChat, OpenCode, Hermes Agent, etc.).
- **Streaming real (SSE):** Las respuestas se envían en tiempo real token por token con latencia mínima.
- **Auto-actualización integrada:** Actualiza el binario directamente desde GitHub Releases con el comando `--update` o con un solo clic desde el Panel de Administración.
- **Soporte multilingüe en el Panel de Administración:** Interfaz web completa con selector de idioma en **Español (ES)**, **Inglés (EN)** y **Chino (中)**.
- **Huella TLS real (Chrome 146):** Evita la detección anti-bot de Cloudflare y Google emulando la pila TLS/JA3/HTTP2 exacta de navegadores modernos.
- **Pool de Cookies inteligente:** Soporta múltiples cuentas de Google, rotación automática y refresco en segundo plano de cookies (`__Secure-1PSIDTS`, `__Secure-1PSIDCC`).
- **Múltiples API Keys con Listas Blancas:** Crea diferentes API Keys para tus usuarios o aplicaciones y asigna qué cuentas de Google pueden utilizar.
- **IP exclusiva por Cookie:** Permite vincular un proxy específico a una cuenta para que nunca mezcle tráfico con otras cuentas o peticiones anónimas.
- **Herramientas y Multimedia:** Soporta llamadas a funciones (tool calling), generación de imágenes (Nano Banana), música (Lyria), modo Canvas y videos (Veo).

---

## Inicio rápido

### Opción 1: Binario precompilado (Recomendado)

Descarga la versión correspondiente a tu sistema operativo desde la página de [Lanzamientos (Releases)](https://github.com/ElJoker63/gemini-web2api-go/releases/latest).

#### En Linux (x86_64 / arm64)
```bash
# Descargar y dar permisos de ejecución
chmod +x gemini-web2api-go_*

# Iniciar el servicio
./gemini-web2api-go_* --port 8844 --admin-token tu_token_secreto
```

#### En Windows
```powershell
.\gemini-proxy.exe --port 8844 --admin-token tu_token_secreto
```

Abre tu navegador en `http://localhost:8844/admin` para acceder al panel de administración.

---

### Opción 2: Docker / Docker Compose

Crea un archivo `docker-compose.yml`:

```yaml
version: '3.8'

services:
  gemini-proxy:
    image: ghcr.io/eljoker63/gemini-web2api-go:latest
    container_name: gemini-proxy
    restart: unless-stopped
    ports:
      - "8844:8844"
    environment:
      - PORT=8844
      - ADMIN_TOKEN=tu_token_secreto
      - API_KEY=tu_api_key_opcional
    volumes:
      - ./data:/app/data
```

Inicia el contenedor:
```bash
docker compose up -d
```

---

## Auto-actualización

El binario incluye capacidad de auto-actualización automática conectándose a los lanzamientos de este repositorio:

### Desde la línea de comandos
Simplemente ejecuta:
```bash
./gemini-proxy --update
```
El binario comprobará si hay una versión más reciente, descargará el archivo correspondiente a tu sistema y arquitectura, reemplazará el binario de forma segura y te notificará para reiniciar el proceso.

### Desde el Panel Web de Administración
Cuando haya una nueva versión disponible, aparecerá una notificación en el panel `/admin`. Puedes pulsar el botón **«Actualizar binario ahora»** para aplicar la actualización con un solo clic.

---

## Conexión con clientes

Configura cualquier aplicación compatible con OpenAI usando:
- **Base URL:** `http://TU_IP:8844/v1`
- **API Key:** La clave configurada en el panel o en `--api-key`.

### Ejemplo con cURL

```bash
curl http://localhost:8844/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tu_api_key" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "¡Hola! ¿Cómo estás?"}]
  }'
```

### Ejemplo con Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8844/v1",
    api_key="tu_api_key"
)

response = client.chat.completions.create(
    model="gemini-3.6-flash",
    messages=[{"role": "user", "content": "Explica la teoría de la relatividad en un párrafo."}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```

---

## Modelos soportados

| Modelo | Descripción | Requisito de cuenta |
| :--- | :--- | :--- |
| `gemini-3.5-flash-lite` | Modelo ultrarrápido y ligero. | Funciona en modo anónimo (sin cuenta). |
| `gemini-3.6-flash` | Modelo balanceado de alta velocidad. | Anónimo o con cuenta de Google. |
| `gemini-3.8-flash` | Versión avanzada de Flash con mayor capacidad de contexto. | Cuenta de Google (gratuita o de pago). |
| `gemini-4-hydrogen` | Modelo 4 Hydrogen con cadena de pensamiento extendida. | Cuenta de Google estándar. |
| `gemini-4-carbon` (antes `gemini-4-argon`) | Modelo más avanzado para razonamiento complejo. | Cuenta de Google con suscripción Google One / Ultra. |
| `gemini-image` | Generación de imágenes (Nano Banana). | Cuenta de Google conectada. |
| `gemini-music` | Generación de música instrumental de ~30s (Lyria). | Cuenta de Google conectada. |
| `gemini-canvas` | Generación de documentos interactivos HTML. | Cuenta de Google conectada. |
| `gemini-video` | Generación de video con modelo Veo. | Cuenta de Google con suscripción. |

---

## API Keys y cuentas exclusivas

En la sección **API Keys** del panel de administración (`/admin`):
- Puedes crear múltiples API Keys independientes.
- Cada clave puede configurarse para tener acceso a **todas las cuentas** o únicamente a una lista blanca de cuentas seleccionadas.
- En el **Pool de Cookies**, puedes marcar una cuenta con **«Exclusivo para esta IP»**, garantizando que esa cuenta utilice únicamente un proxy específico asignado.

---

## Pool de Proxies

Para maximizar el volumen de peticiones y evitar límites de tasa por IP de Google:
- Puedes agregar múltiples proxies HTTP, HTTPS o SOCKS5 en la pestaña **Pool de Proxies**.
- Cada proxy cuenta con límites independientes de concurrencia, peticiones por minuto (RPM) y peticiones por hora (RPH).
- Si usas proxies rotativos o dinámicos, puedes establecer `proxy_cooldown_min: -1` para que los proxies no se desactiven automáticamente tras fallos transitorios.

---

## Opciones de configuración (CLI y config.json)

| Parámetro | Descripción |
| :--- | :--- |
| `--port` | Puerto de escucha (por defecto `8083`). |
| `--config` | Ruta al archivo `config.json`. |
| `--db` | Ruta a la base de datos SQLite (por defecto `./data/gemini.db`). |
| `--admin-token` | Token de acceso al panel web `/admin`. |
| `--api-key` | Fija una clave API maestra de despliegue de solo lectura. |
| `--cookie-file` | Importa un archivo de cookies al inicio. |
| `--proxy` | Proxy de respaldo por defecto. |
| `--update` | Comprueba y aplica la auto-actualización del binario desde GitHub. |
| `--version` | Muestra la versión actual y finaliza. |

---

## Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Consulta el archivo [LICENSE](LICENSE) para más detalles.
