# Branchdeck

Branchdeck is a small branch-preview control plane for Netlify-oriented projects.

It is intentionally named without `netlify` in the product identity, but it does not hide the implementation: the app is built around the `netlify dev` CLI and is meant for projects developed for Netlify.

## What it includes

- admin panel on `8080`
- public app entrypoint on `8888`
- Git branch sync and dependency install
- `netlify dev` runtime supervision
- optional public auth in front of the app
- GitHub OAuth endpoints for Decap CMS

## Quick start

1. Copy `.env.example` to `.env`.
2. Set `SESSION_SECRET`, `ADMIN_PASSWORD`, `GIT_REPO_URL`, and `GIT_BRANCH`.
3. Run `docker compose up -d --build`.
4. Open `http://127.0.0.1:8080/login`.

Default ports:

- `8080`: Branchdeck admin panel
- `8888`: public app proxy
- `8999`: internal `netlify dev` port
