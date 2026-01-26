---
name: workers-fetch
description: Test Cloudflare Workers apps via workers-fetch CLI.
---

# Workers Fetch Skill

Test your Workers app using the `workers-fetch` CLI (installed globally via bun).

## Commands for AI

### 1. Usage Help

```bash
workers-fetch --help
```

Show available options and usage details.

### 2. Basic Request

```bash
# GET request
workers-fetch /path

# POST request with JSON body
workers-fetch -X POST /api/items -d '{"name":"test"}'
```

### 3. Request with Headers

```bash
workers-fetch -H "Authorization: Bearer token" /api/protected
```

### 4. Use Wrangler Config

```bash
workers-fetch -c wrangler.jsonc /tables
```

## Guidelines

- Use this tool to test app handlers without starting a server.
- Prefer `workers-fetch --help` if flags are uncertain.
- Keep payloads minimal and deterministic for repeatable tests.