# deploy

Docker Compose definition for `web`, `api`, `worker`, `db` with persistent volumes.

- Compose file: [`docker-compose.yml`](docker-compose.yml).
- Operations and configuration: [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) and
  [`../docs/OPERATOR_GUIDE.md`](../docs/OPERATOR_GUIDE.md).
- Copy [`../.env.example`](../.env.example) to `../.env` and set real secrets before a deployment.

The intended reverse-proxy configuration is described in `docs/DEPLOYMENT.md` §8; an example
proxy config is not yet shipped here.
