# RocketReach MCP — Cloudflare Worker

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server for the [RocketReach API](https://rocketreach.co/), deployed as a **Cloudflare Worker**.

Exposes three tools that any MCP-compatible client (Claude Desktop, Cursor, Windsurf, etc.) can call:

| Tool | Description |
|---|---|
| `search_people` | Search people by name, employer, title, or location |
| `lookup_person` | Full profile + verified contact info (emails, phones) |
| `lookup_company` | Company details: size, revenue, industry, location |

---

## Why a Cloudflare Worker?

The server uses [`createMcpHandler`](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) from the Cloudflare Agents SDK — a **stateless** MCP handler that runs in a plain Worker (no Durable Objects needed). Each request is fully self-contained; the RocketReach API key is read directly from the incoming `ROCKETREACH_API_KEY` header, so multiple users can share the same deployment with different keys.

---

## Quick deploy

```bash
# 1. Clone and install
git clone https://github.com/balazsnemeth/rocketreach-mcp-worker.git
cd rocketreach-mcp-worker
npm install

# 2. Log in to Cloudflare (first time only)
npx wrangler login

# 3. Deploy
npm run deploy
```

The worker is now live at `https://rocketreach-mcp.<your-subdomain>.workers.dev/mcp`.

### Optional: store a default API key as a secret

If you want the worker to work without a per-request header (e.g. for personal use), store your key as a Worker secret:

```bash
npx wrangler secret put ROCKETREACH_API_KEY
```

---

## Client configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "rocketreach": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://rocketreach-mcp.<your-subdomain>.workers.dev/mcp",
        "--header",
        "ROCKETREACH_API_KEY:<your-rocketreach-api-key>"
      ]
    }
  }
}
```

### Cursor / Windsurf

Add to your MCP settings file:

```json
{
  "rocketreach": {
    "command": "npx",
    "args": [
      "mcp-remote",
      "https://rocketreach-mcp.<your-subdomain>.workers.dev/mcp",
      "--header",
      "ROCKETREACH_API_KEY:<your-rocketreach-api-key>"
    ]
  }
}
```

> **Note:** `mcp-remote` proxies the local stdio transport (used by MCP clients) to the remote HTTP endpoint. Install it globally if needed: `npm install -g mcp-remote`.

---

## Tools reference

### `search_people`

Search for people in RocketReach. Returns basic profile information — no contact details are consumed from your plan's credit quota.

**Parameters**

| Parameter | Type | Description |
|---|---|---|
| `name` | `string \| string[]` | Full name or list of names — e.g. `"Elon Musk"` |
| `current_employer` | `string \| string[]` | Company name or list — e.g. `"Tesla"` |
| `title` | `string \| string[]` | Job title or list — e.g. `"CEO"` |
| `location` | `string \| string[]` | City / region or list — e.g. `"San Francisco"` |
| `radius_miles` | `number` | Radius around `location` in miles (optional) |
| `start` | `number` | 1-based pagination offset (default: `1`) |
| `page_size` | `number` | Results per page, max 100 (default: `20`) |

At least one of `name`, `current_employer`, `title`, or `location` is required.

**Response shape**

```json
{
  "total_results": 42,
  "start": 1,
  "next": 21,
  "profiles": [
    {
      "id": 12345678,
      "name": "Elon Musk",
      "current_employer": "Tesla",
      "current_title": "CEO",
      "location": "Austin, TX",
      "linkedin_url": "https://www.linkedin.com/in/elonmusk"
    }
  ]
}
```

---

### `lookup_person`

Get a full person profile including verified contact information. Uses one credit per unique lookup.

**Parameters**

| Parameter | Type | Description |
|---|---|---|
| `identifier` | `string` | The identifier value (see `lookup_type`) |
| `lookup_type` | `string` | How to identify the person (default: `"id"`) |

**`lookup_type` values**

| Value | `identifier` format | Notes |
|---|---|---|
| `id` | RocketReach numeric ID | Fastest, most reliable |
| `linkedin_url` | Full LinkedIn profile URL | |
| `email` | Email address | |
| `name_employer` | `"Full Name\|Company Name"` | Pipe-separated |
| `npi` | NPI number | Healthcare providers only |

**Response** includes `id`, `name`, `current_employer`, `current_title`, `location`, `linkedin_url`, `status`, `contact_info` (emails, phones, work email), `job_history`, `education`, `skills`, and `social_profiles`.

---

### `lookup_company`

Get detailed company information.

**Parameters**

| Parameter | Type | Description |
|---|---|---|
| `identifier` | `string` | The identifier value (see `lookup_type`) |
| `lookup_type` | `string` | How to identify the company (default: `"domain"`) |

**`lookup_type` values**

| Value | Example |
|---|---|
| `domain` | `"rocketreach.co"` (preferred) |
| `name` | `"RocketReach"` |
| `linkedin_url` | Full LinkedIn company URL |
| `ticker` | `"AAPL"` |
| `id` | RocketReach internal company ID |

**Response** includes `id`, `name`, `domain`, `website`, `linkedin_url`, `description`, `industry`, `employees`, `employee_range`, `revenue`, `revenue_range`, `city`, `state`, `country`, `address`, `founded_year`, `company_type`, `ticker`, and `logo_url`.

---

## Local development

```bash
npm run dev
```

The worker is served at `http://localhost:8787`. Point `mcp-remote` at it for local testing:

```json
{
  "rocketreach": {
    "command": "npx",
    "args": [
      "mcp-remote",
      "http://localhost:8787/mcp",
      "--header",
      "ROCKETREACH_API_KEY:<your-key>"
    ]
  }
}
```

---

## API key priority

1. `ROCKETREACH_API_KEY` **request header** (sent by `mcp-remote --header`) — per-user, per-request
2. `ROCKETREACH_API_KEY` **Worker secret** — shared fallback (set via `wrangler secret put`)

If neither is present the worker returns `401`.

---

## Tech stack

- [Cloudflare Workers](https://workers.cloudflare.com/) — edge runtime
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) — `createMcpHandler` for stateless MCP transport
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP protocol
- [Zod](https://zod.dev/) — tool input validation
- TypeScript

## License

MIT
