# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/logitping/logitping/security/advisories/new) when the repository's **Report a vulnerability** form is available. Do not put exploit details, credentials, private endpoint URLs, or sensitive logs in a public issue, pull request, or discussion.

**Channel status, 2026-10-08:** the repository was not publicly accessible during the npm release check. The private reporting form has not been verified as available, and this project has not published a dedicated security email address. Creating this file does not enable GitHub private reporting.

Until the form is available:

- If a maintainer supplied your checkout or source archive, use that existing private contact to request a secure reporting channel before sharing details.
- If the repository is accessible but the form is missing, open an issue containing only a request for a private security contact. Do not describe the vulnerability or attach a proof of concept there.
- If neither route is available, retain the report privately until a maintainer provides a channel. Do not guess an email address or send secrets to an unverified recipient.

A repository administrator still needs to enable private vulnerability reporting and verify that an external reporter can use it, or replace this section with a monitored private contact. GitHub's [reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) explain the separate repository setting and reporting form.

## Versions and response expectations

The current npm release is experimental version `0.1.0`; no stable release or long-term support branch is currently offered. Include the package version and, for a source build, the commit in your report. Fixes are intended for the current development line; older commits do not have a promised backport policy.

Reports and fixes are handled on a best-effort basis. There is no guaranteed response time, remediation deadline, or bounty program. Once a private channel is established, coordinate disclosure and any credit with the maintainer rather than assuming a publication date.

## What to include

- Affected version or commit, Node.js version, operating system, and the transport or command involved.
- A description of the impact and the conditions required to trigger it.
- A minimal reproduction using synthetic credentials, fake local endpoints, or fake CLI processes where possible.
- Sanitized output and a suggested fix, if you have one.

Never attach `.env`, authentication stores, real API keys, private gateway/account identifiers, or unreviewed environment dumps. If a real credential has been exposed, revoke or rotate it with the provider; removing it from a report does not invalidate it.

Potential issues include unintended credential disclosure, command execution or file access outside the documented transport behavior, parser/resource exhaustion problems, and a bypass of documented endpoint or protocol checks. Ordinary model misclassification, inconclusive results, and changes in provider behavior are known research limitations; report those through the [contribution process](CONTRIBUTING.md), with sanitized evidence. A security impact beyond those limitations should still be reported privately.

## Security boundaries

- **Endpoint choice is a trust boundary.** An explicit API key or `LOGITPING_API_KEY` is sent to the endpoint you configure. Vendor environment keys are restricted to their vendor's HTTPS host. HTTPS is required except for local loopback endpoints unless `--allow-insecure-http` is explicitly enabled. Redirects are rejected.
- **Developer CLIs retain local access.** Claude and Codex probes reuse installed executables, authentication, and user configuration. They inherit the environment except for `LOGITPING_API_KEY`; other secrets present in the environment may still be available to the child process. Use only trusted binaries and backends.
- **Codex isolation is limited.** Read-only configuration, disabled features, MCP overrides, and an empty temporary directory narrow the available actions. Some tools can start before the driver observes the event and terminates the process. These controls do not create a hermetic sandbox. See [transport limitations](docs/transports.md).
- **Results are experimental.** Behavioral similarity and nominal confidence do not prove identity, provenance, or a billing claim. An adaptive endpoint can recognize or imitate probes. Keep an independent source of trust for security decisions.
- **Logs and submitted files need review.** Built-in errors are bounded and redacted, but arbitrary custom transports, raw streamed text, and surrounding tools can expose sensitive data. Review every attachment before sharing it.
