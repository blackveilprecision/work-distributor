# Contributing to wd

Thanks for helping. wd is small on purpose, so the best contributions are focused: a bug fixed with a test, a rough edge
smoothed, a host setup that did not work made to work.

## Before you start
- Read [AGENTS.md](AGENTS.md): the commands, the rules every change follows, and how to deploy. It is written for coding
  agents and people alike.
- Read [docs/how-it-works.md](docs/how-it-works.md) before changing behaviour.
- For anything bigger than a fix, open an issue first and say what you want to change and why. wd runs threads and
  reports on them; planning, PR handling, merging, review and retries belong to the caller and will not be added.

## Setting up
You need [Bun](https://bun.sh) 1.3 or newer and `git`. The tests never run a real `claude` and never call GitHub, so
you need neither a Claude login nor any machines besides your own.

```sh
bun install
bun test            # about a minute, including end-to-end tests against a fake claude and a local bare repo
bunx tsc --noEmit
bun run build       # dist/wd
```

`wd init-local` in the [README](README.md#try-it-on-one-machine) starts a coordinator and an agent on one machine, if you
want to see a change working with a real `claude`.

## Making a change
- `src/shared/types.ts` is the contract between the coordinator, the agent and the clients: change it first.
- Add or change tests with the code. Tests run on macOS and Linux; keep the host tools to the ones AGENTS.md lists.
- Keep it small: plain code, no frameworks, no npm dependencies beyond the two in package.json. Comments only where the
  reason is not obvious.
- A new CLI command or flag gets a description, since `wd <command> --help` is its documentation.
- Update the README and docs/how-it-works.md when behaviour, commands or the API change.
- `bun test`, `bunx tsc --noEmit` and `bun run build` must pass. CI runs tsc, the build and the coordinator and client
  tests on Linux; the agent and end-to-end tests need macOS, so run the full `bun test` yourself.

## Pull requests
One topic per pull request, with a description of what changed, why, and how you checked it. If it changes how wd
behaves on real hosts, say which OS you tried it on.

## Security
wd uses bearer tokens without TLS and is meant for a private network; the caller token is an admin credential (see the
README). Please report a security problem privately through GitHub's "Report a vulnerability" on this repository,
not in a public issue.

## License
By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
