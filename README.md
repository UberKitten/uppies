# uppies

[![build](https://github.com/UberKitten/uppies/actions/workflows/build.yml/badge.svg)](https://github.com/UberKitten/uppies/actions/workflows/build.yml)
[![ghcr](https://img.shields.io/badge/ghcr.io-uberkitten%2Fuppies-blue)](https://github.com/UberKitten/uppies/pkgs/container/uppies)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A minimal self-hosted file-receive service. One Docker container, one process,
one log stream. CLI-only share management — no web admin, no user accounts,
no logins of any kind. **The URL is the password.**

## What it does

Create a share from the CLI, get back a long unguessable URL, hand the URL to
whoever needs to send you files. They open the link in any browser, drop files
on the page, and the files land in a directory you control. They can return to
the same URL later to upload more or to grab the files back.

- **Resumable uploads** (tus protocol via Uppy)
- **Files of any size** — no in-memory buffering, streamed to disk
- **Returning-user UX** — the page shows file history with relative timestamps;
  no session state, no "your last visit" markers, just the URL
- **Banner states** for expired / full shares (existing files stay downloadable)
- **Light + dark mode** following `prefers-color-scheme`
- **One container, one bind mount** — bring your own reverse proxy / TLS

## Quick start

The image is published to `ghcr.io/uberkitten/uppies:latest`. Drop this in a
`docker-compose.yml`:

```yaml
services:
  uppies:
    image: ghcr.io/uberkitten/uppies:latest
    container_name: uppies
    restart: unless-stopped
    environment:
      UPPIES_PUBLIC_URL: https://up.example.com
    ports:
      - "8050:3000"
    volumes:
      - /srv/uppies:/data
```

```sh
# Container runs as uid 1000
mkdir -p /srv/uppies && chown 1000:1000 /srv/uppies

docker compose up -d

# Create your first share
docker exec uppies uppies share create "My share" --max-size 50GB --expires 2027-01-31
```

The CLI prints the full URL — open it in a browser, drop files, done.

> Want to build from source instead?  
> `git clone` this repo and `docker compose build` — the bundled
> `docker-compose.yml` builds locally and includes example traefik labels.

## Environment variables

| Var                  | Default       | Notes                                                                  |
|----------------------|---------------|------------------------------------------------------------------------|
| `UPPIES_STORAGE_DIR` | `/data`       | Where db + shares + tus tmp live (inside the container).               |
| `UPPIES_PORT`        | `3000`        | Internal HTTP port.                                                    |
| `UPPIES_HOST`        | `0.0.0.0`     | Bind interface.                                                        |
| `UPPIES_PUBLIC_URL`  | _unset_       | Used by the CLI to print full share URLs. e.g. `https://up.example.com` |
| `UPPIES_HOST_STORAGE`| `./data`      | Host path for the storage bind mount (used in `docker-compose.yml`).   |

## CLI

The CLI works against the sqlite + filesystem directly. It does **not** need
the server to be running — you can manage shares during maintenance.

```sh
# Create
uppies share create "Project X handoff" --max-size 100GB --max-files 10000 --expires 2026-12-31

# List
uppies share list
uppies share list --json

# Show details (incl. on-disk storage path)
uppies share show <id>

# Extend expiry (or clear it with --expires "")
uppies share extend <id> --expires 2027-06-30
uppies share extend <id> --expires ""

# Delete (asks for the share id to confirm; --force skips)
uppies share delete <id>
uppies share delete <id> --force
```

To run the CLI against a live container:

```sh
docker exec uppies uppies share list
```

For inspecting / removing individual files, use ordinary shell tools against
the storage directory — `uppies share show <id>` prints the path.

## Storage layout

```
${UPPIES_STORAGE_DIR}/
├── db.sqlite                # the catalog of shares + files
├── shares/
│   └── <shareId>/
│       └── <tusUploadId>    # one file per completed upload, named by tus ID
└── tmp/                     # @tus/file-store working dir for in-flight uploads
```

The on-disk filename is the tus upload ID. The original filename is stored in
sqlite and used for `Content-Disposition` on download. Same filename can be
uploaded N times — they're separate rows with separate tus IDs.

## URL routes

- `GET /` → boring 404 (nothing useful at the root)
- `GET /<shareId>` → upload page (HTML, share name in `<title>`)
- `GET /<shareId>/files` → JSON: share metadata + files (newest first)
- `GET /<shareId>/files/<fileId>` → file download (streamed)
- `POST/PATCH/HEAD /api/tus[/<id>]` → tus upload protocol
- `GET /static/*` → bundled frontend assets
- `GET /health` → `{"ok": true}`

Share IDs are 24-char urlsafe random (≥143 bits of entropy). The path-routing
order ensures `/api/...` and `/static/...` are matched before the shareId
catch-all; the generator additionally skips IDs that collide with any reserved
prefix.

## Behind a reverse proxy

Inside the container the server speaks plain HTTP on port 3000 (mapped to host
`8050` in the bundled compose file). Terminate TLS at your reverse proxy.

The server honours `X-Forwarded-Proto`, `X-Forwarded-Host`, and `Forwarded`
headers when generating tus upload URLs — make sure your proxy passes them.

For uploads of arbitrary size, your proxy needs:
- a high (or disabled) request-body size limit
- long client/upstream timeouts (tus PATCH requests can run for minutes for
  large chunks; the default Uppy chunk size set by this app is 16 MB)
- no buffering of request bodies to disk before forwarding

## Bind-mount permissions

The container runs as `uid 1000` (the `node` user from the upstream
`node:22-alpine` image). The bind-mounted storage dir on the host needs to be
writable by that uid:

```sh
mkdir -p /srv/uppies
chown 1000:1000 /srv/uppies
```

(Or run the container as root — but don't.)

## Browser support

The frontend uses Uppy core + `@uppy/tus` with vanilla DOM (no framework
runtime shipped). It assumes a current evergreen browser (anything that ships
`fetch`, `matchMedia`, modern CSS color functions).

## Constraints / things this does NOT do

By design:
- No logins, accounts, admin UI, or share editing from the web
- No virus scanning, notifications, or email
- No per-file deletion endpoint — use the filesystem
- No pagination of the file list

## Hacking

```sh
npm install
npm run build:frontend
UPPIES_STORAGE_DIR=./data npm start
```

The frontend bundle is a single esbuild call (`scripts/build-frontend.js`).
Source files: `src/` (server + CLI), `frontend/` (HTML + CSS + JS).
