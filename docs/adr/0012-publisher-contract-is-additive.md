# The publisher contract only grows

Status: accepted on 2026-10-22.

The plugin publisher (`apps/site/server`) deploys to Vercel independently of the runtime, and every installed daemon calls it at a fixed origin. A released daemon can therefore meet a newer publisher at any time. The request and response schemas live once in `packages/protocol` and are used by both sides. The publisher only adds fields and routes; it never removes or reinterprets one a supported runtime release reads. Daemons ignore fields they do not know. A shape that has to change ships on a new route, and the old route is removed one runtime release after daemons stop calling it.

Unknown fields are ignored inside known objects too: a publisher that adds a field to a token response's `identity` object must not break OAuth token exchange or refresh. Fields a daemon reads stay required, so an identity object without a `subject` is still rejected.
