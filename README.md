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

`npm run check` runs all of the above.

## Releasing

Every push to `Main` builds the release files and test-installs them on real
Windows and Linux machines in GitHub Actions. To publish a release, push a
version tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The Release workflow then runs the full check, publishes a GitHub release and
installs it from GitHub on Windows and Linux. A tag with a suffix, like
`v0.1.0-rc.1`, becomes a pre-release: the install commands and
`ccunified update` ignore it.

## License

[MIT](LICENSE)
