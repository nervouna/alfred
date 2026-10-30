# Security

Alfred runs an agent with tools on its owner's machine, so its boundaries matter: the workspace guard, the read-only rules and memory, the command API on a local socket, the workbench behind Cloudflare Access, and the spend caps ([docs/agent.md](docs/agent.md#agent-sandbox), [docs/workbench.md](docs/workbench.md)).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/nervouna/alfred/security/advisories/new)). Include what you did, what happened, and the commit you tested.

You will get an answer within a week. Fixes land on `main`; there are no maintained release branches.

## In scope

- A way for content the agent reads (a web page, an uploaded file, a tool result) to make it act outside the workspace, change `ALFRED.md` or memory, or make something it wrote executable
- A way past the workbench's Access check or the device tokens
- A way to exceed the spend caps

## Out of scope

- Anything that needs the owner's paired device, the Anthropic key or shell access to the host
- The model doing something unwise inside the workspace that the owner asked for
