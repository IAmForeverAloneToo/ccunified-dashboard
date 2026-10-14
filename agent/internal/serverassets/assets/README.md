The build copies the dashboard here before compiling ccunified:

- `worker.js` — the bundled Cloudflare Worker (with the dashboard inside), from `worker/dist/worker.js`
- `migrations/*.sql` — the database migrations, from `worker/migrations/`

Run `npm run build:assets` from the repository root. These copies are not
committed; the sources live in `worker/`.
