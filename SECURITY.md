# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead: open this
repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it and
which version you tested.

Atlas is maintained by one person, so there is no fixed response time, but reports are read and taken seriously.

## Supported versions

Only the latest release is supported. Atlas is a `0.1.x` pre-release intended for private networks; see
[`docs/RELEASE.md`](docs/RELEASE.md) for what that means.

## Scope

The threat model, controls and known limitations are in [`docs/SECURITY.md`](docs/SECURITY.md). Reports about a
deployment that exposes Atlas to the internet without HTTPS, or that keeps the placeholder secrets from
`.env.example`, are configuration problems rather than vulnerabilities, but we are glad to improve the warnings.
