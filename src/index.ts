/**
 * RocketReach MCP Server — Cloudflare Worker
 *
 * Exposes three tools over the MCP Streamable HTTP transport at /mcp:
 *   - search_people
 *   - lookup_person
 *   - lookup_company
 *
 * The RocketReach API key is read from the ROCKETREACH_API_KEY request header
 * (sent by mcp-remote --header), falling back to the ROCKETREACH_API_KEY
 * environment variable / Worker secret.
 *
 * Claude Desktop config example:
 *   "rocketreach": {
 *     "command": "npx",
 *     "args": [
 *       "mcp-remote",
 *       "https://rocketreach-mcp.rolloutit.workers.dev/mcp",
 *       "--header",
 *       "ROCKETREACH_API_KEY:<your-key>"
 *     ]
 *   }
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface Env {
  ROCKETREACH_API_KEY?: string;
}

// ---------------------------------------------------------------------------
// RocketReach API client
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.rocketreach.co/api/v2";

const HTTP_ERRORS: Record<number, string> = {
  400: "Bad request — check parameters",
  401: "Invalid API key — check your RocketReach credentials",
  402: "Insufficient credits — please check your account balance",
  403: "Forbidden — your plan may not allow this endpoint",
  404: "Not found",
  429: "Rate limit exceeded — please wait and try again",
};

interface ApiOptions {
  method: "GET" | "POST";
  endpoint: string;
  params?: Record<string, string>;
  body?: unknown;
  apiKey: string;
}

async function rrFetch({ method, endpoint, params, body, apiKey }: ApiOptions): Promise<unknown> {
  const url = new URL(`${BASE_URL}/${endpoint.replace(/^\//, "")}`);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Api-Key": apiKey,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { error: `Network error: ${String(err)}` };
  }

  if (!response.ok) {
    const message = HTTP_ERRORS[response.status] ?? `HTTP ${response.status} error`;
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = await response.text();
    }
    return { error: message, details };
  }

  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON response", raw: text };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value: string | string[] | undefined | null): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.length ? value : undefined;
  return [value];
}

function toText(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP server factory (created per-request so it captures the correct apiKey)
// ---------------------------------------------------------------------------

function buildServer(apiKey: string): McpServer {
  const server = new McpServer({ name: "RocketReach API", version: "1.0.0" });

  // -----------------------------------------------------------------------
  // search_people
  // -----------------------------------------------------------------------
  server.tool(
    "search_people",
    [
      "Search for people in RocketReach. Returns basic profile info (no contact details).",
      "Provide at least one filter: name, current_employer, title, or location.",
      "Use lookup_person to retrieve full contact details for a specific profile id.",
    ].join(" "),
    {
      name: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Person full name or list of names — e.g. 'Elon Musk'"),
      current_employer: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Current company name or list — e.g. 'Tesla'"),
      title: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Job title or list — e.g. 'CEO'"),
      location: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("City / region or list — e.g. 'San Francisco'"),
      radius_miles: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Radius around location in miles (only used when location is set)"),
      start: z.number().int().min(1).default(1).describe("1-based offset for pagination"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Results per page, max 100"),
    },
    async ({ name, current_employer, title, location, radius_miles, start, page_size }) => {
      let locationList = asArray(location);
      if (locationList && radius_miles) {
        locationList = locationList.map((loc) => `${loc}::~${radius_miles}mi`);
      }

      const query: Record<string, string[]> = {};
      const candidates: Record<string, string[] | undefined> = {
        name: asArray(name),
        current_employer: asArray(current_employer),
        current_title: asArray(title),
        location: locationList,
      };
      for (const [key, val] of Object.entries(candidates)) {
        if (val?.length) query[key] = val;
      }

      if (!Object.keys(query).length) {
        return toText({ error: "Provide at least one filter: name, current_employer, title, or location." });
      }

      const result = (await rrFetch({
        method: "POST",
        endpoint: "/person/search",
        body: { query, start: Math.max(1, start), page_size: Math.min(Math.max(1, page_size), 100) },
        apiKey,
      })) as Record<string, unknown>;

      if ("error" in result) return toText(result);

      const profiles = (result.profiles as Record<string, unknown>[]) ?? [];
      const pagination = (result.pagination as Record<string, unknown>) ?? {};

      return toText({
        total_results: pagination.total ?? profiles.length,
        start: pagination.start ?? start,
        next: pagination.next,
        profiles: profiles.map((p) => ({
          id: p.id,
          name: p.name,
          current_employer: p.current_employer,
          current_title: p.current_title,
          location: p.location,
          linkedin_url: p.linkedin_url,
        })),
      });
    },
  );

  // -----------------------------------------------------------------------
  // lookup_person
  // -----------------------------------------------------------------------
  server.tool(
    "lookup_person",
    [
      "Get a full person profile including verified contact information (emails, phones).",
      "lookup_type options: 'id' (RocketReach ID — fastest), 'linkedin_url', 'email',",
      "'name_employer' (identifier must be 'Full Name|Company Name'), 'npi' (healthcare NPI number).",
    ].join(" "),
    {
      identifier: z.string().describe("Identifier value matching lookup_type"),
      lookup_type: z
        .enum(["id", "linkedin_url", "email", "name_employer", "npi"])
        .default("id")
        .describe("How to identify the person"),
    },
    async ({ identifier, lookup_type }) => {
      let params: Record<string, string>;

      switch (lookup_type) {
        case "id":
          params = { id: identifier };
          break;
        case "linkedin_url":
          params = { linkedin_url: identifier };
          break;
        case "email":
          params = { email: identifier };
          break;
        case "npi":
          params = { npi_id: identifier };
          break;
        case "name_employer": {
          if (!identifier.includes("|")) {
            return toText({ error: "name_employer requires format: 'Full Name|Company Name'" });
          }
          const [namePart, employerPart] = identifier.split("|", 2).map((s) => s.trim());
          if (!namePart || !employerPart) {
            return toText({ error: "Both name and employer are required for name_employer lookup." });
          }
          params = { name: namePart, current_employer: employerPart };
          break;
        }
      }

      const result = (await rrFetch({
        method: "GET",
        endpoint: "/person/lookup",
        params,
        apiKey,
      })) as Record<string, unknown>;

      if ("error" in result) return toText(result);
      if (!result || !("id" in result)) return toText({ error: "No profile found", raw: result });

      const raw: Record<string, unknown> = {
        id: result.id,
        status: result.status,
        name: result.name,
        current_employer: result.current_employer,
        current_title: result.current_title,
        location: result.location,
        linkedin_url: result.linkedin_url,
        contact_info: {
          emails: result.emails ?? [],
          phones: result.phones ?? [],
          current_work_email: result.current_work_email,
          recommended_email: result.recommended_email,
          recommended_personal_email: result.recommended_personal_email,
        },
        job_history: result.job_history ?? [],
        education: result.education ?? [],
        skills: result.skills ?? [],
        social_profiles: {
          twitter_url: result.twitter_url,
          github_url: result.github_url,
          facebook_url: result.facebook_url,
        },
      };

      // Remove nullish / empty-collection fields, but always keep "status"
      const cleaned = Object.fromEntries(
        Object.entries(raw).filter(([key, v]) => {
          if (key === "status") return true;
          if (v === null || v === undefined) return false;
          if (Array.isArray(v) && v.length === 0) return false;
          if (
            typeof v === "object" &&
            !Array.isArray(v) &&
            Object.values(v as object).every((x) => x == null)
          )
            return false;
          return true;
        }),
      );

      return toText(cleaned);
    },
  );

  // -----------------------------------------------------------------------
  // lookup_company
  // -----------------------------------------------------------------------
  server.tool(
    "lookup_company",
    [
      "Get detailed company information: size, revenue, industry, location, etc.",
      "lookup_type options: 'domain' (preferred, e.g. 'rocketreach.co'), 'name',",
      "'linkedin_url', 'ticker' (stock ticker, e.g. 'AAPL'), 'id' (RocketReach company ID).",
    ].join(" "),
    {
      identifier: z.string().describe("Identifier value matching lookup_type"),
      lookup_type: z
        .enum(["domain", "name", "linkedin_url", "ticker", "id"])
        .default("domain")
        .describe("How to identify the company"),
    },
    async ({ identifier, lookup_type }) => {
      const result = (await rrFetch({
        method: "GET",
        endpoint: "/company/lookup",
        params: { [lookup_type]: identifier },
        apiKey,
      })) as Record<string, unknown>;

      if ("error" in result) return toText(result);
      if (!result || !("id" in result)) return toText({ error: "No company found", raw: result });

      return toText({
        id: result.id,
        name: result.name,
        domain: result.domain,
        website: result.website,
        linkedin_url: result.linkedin_url,
        description: result.description,
        industry: result.industry,
        employees: result.employees,
        employee_range: result.employee_range,
        revenue: result.revenue,
        revenue_range: result.revenue_range,
        city: result.city,
        state: result.state,
        country: result.country,
        address: result.address,
        founded_year: result.founded,
        company_type: result.type,
        ticker: result.ticker,
        logo_url: result.logo_url,
      });
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health-check / landing page
    if (!url.pathname.startsWith("/mcp")) {
      return new Response(
        JSON.stringify({ name: "RocketReach MCP Server", endpoint: "/mcp" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Resolve API key: request header takes precedence over env var / secret
    const apiKey =
      request.headers.get("ROCKETREACH_API_KEY") ?? env.ROCKETREACH_API_KEY ?? null;

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "Missing API key. Pass it via the ROCKETREACH_API_KEY header or set the ROCKETREACH_API_KEY Worker secret.",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const server = buildServer(apiKey);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
