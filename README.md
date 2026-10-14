# ccunified

One dashboard for your Claude Code token usage across all your machines.

A small program on each machine reads Claude Code's local usage logs (using
[ccusage](https://github.com/ccusage/ccusage)) and uploads daily totals to a
dashboard on your own domain, hosted on your own Cloudflare account.

> **Status: under construction.** Nothing is ready to install yet.
> See [PLAN.md](PLAN.md) for the design and progress.

## Development

Requirements: Node.js 24 LTS with npm 12.2+, and Go 1.27+.

```sh
npm ci                 # install JavaScript tooling
npm run lint           # Biome
npm run typecheck      # TypeScript
npm test               # Worker tests run inside workerd (Cloudflare's runtime)
npm run build          # build dashboard + Worker bundle

cd agent
go vet ./... && go test ./...
```

## License

[MIT](LICENSE)
