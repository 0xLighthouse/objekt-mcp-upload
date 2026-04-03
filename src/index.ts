#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GATEWAY_URL = process.env.OBJEKT_GATEWAY_URL ?? "https://api.objekt.sh";
const API_KEY = process.env.OBJEKT_API_KEY ?? "";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

function mimeFromPath(filePath: string): string {
  return (
    MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

const MAX_CONTENT_BYTES = 500 * 1024; // 500KB limit for inline content (saves tokens)

const server = new McpServer(
  { name: "Objekt.sh", version: "0.1.4" },
  {
    instructions: [
      "Objekt.sh uploads files to decentralised storage (CDN, IPFS, Arweave).",
      "",
      "Encoding: use 'raw' for text formats (SVG, HTML, CSS, JSON, Markdown) — no base64 overhead.",
      "Use 'base64' (default) for binary formats (PNG, JPEG, WebP, GIF, PDF).",
      "",
      "Supported formats: JPEG, PNG, WebP, GIF, SVG, PDF (up to 5MB via path, 500KB via content).",
      "For host filesystem files, ALWAYS prefer the 'path' parameter — reads from disk, zero token cost.",
      "Inline 'content' is capped at 500KB to avoid wasting tokens. Use 'path' for anything larger.",
      "",
      "Uploaded files return a permalink. Use get_file to check if a file already exists before re-uploading.",
    ].join("\n"),
  },
);

// ─── upload_file ─────────────────────────────────────────────────────────────

server.registerTool(
  "upload_file",
  {
    title: "Upload File",
    description: `Upload a file to objekt.sh storage. Accepts a host file path OR base64/raw content.

For files on the HOST filesystem (e.g. /Users/name/photo.png): use 'path' — reads from disk, fastest.
For files you have in memory: use 'content' + 'content_type'.
For files at CONTAINER paths (e.g. /mnt/user-data/): use the upload_from_sandbox tool instead.`,
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe(
          "Absolute path to the file on the HOST filesystem (e.g. /Users/you/photo.png). Do NOT use container paths like /mnt/user-data/.",
        ),
      content: z
        .string()
        .optional()
        .describe(
          "File content — base64-encoded for binaries, raw UTF-8 for text. Use this when the file path is not accessible from the host filesystem.",
        ),
      content_type: z
        .string()
        .optional()
        .describe(
          "MIME type (required with content, e.g. 'image/png'). Auto-detected when using path.",
        ),
      encoding: z
        .enum(["base64", "raw"])
        .optional()
        .describe(
          "Content encoding. Default 'base64'. Use 'raw' for text types like SVG, HTML, CSS, JSON.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Filename for the upload. Auto-detected from 'path'. Required when using 'content'.",
        ),
    }),
    annotations: {
      title: "Upload File",
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async ({
    path: filePath,
    content,
    content_type,
    encoding = "base64",
    name: customName,
  }) => {
    if (!API_KEY) {
      return {
        content: [
          {
            type: "text" as const,
            text: "OBJEKT_API_KEY not set. Get a free key at objekt.sh/mcp",
          },
        ],
        isError: true,
      };
    }

    let fileBytes: Uint8Array;
    let fileMime: string;
    let fileName: string;

    if (filePath) {
      if (
        filePath.startsWith("/mnt/") ||
        filePath.startsWith("/sandbox/") ||
        filePath.startsWith("/tmp/sandbox")
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `"${filePath}" is a sandbox path — this tool runs on the host and cannot access it. Use upload_from_sandbox for sandbox files, or pass the content directly via the "content" parameter with "encoding": "raw" for text files or "base64" for binaries.`,
            },
          ],
          isError: true,
        };
      }

      const absPath = resolve(filePath);
      try {
        await stat(absPath);
      } catch {
        return {
          content: [
            { type: "text" as const, text: `File not found: ${absPath}` },
          ],
          isError: true,
        };
      }

      const buffer = await readFile(absPath);
      fileBytes = new Uint8Array(buffer);
      fileMime = mimeFromPath(absPath);
      fileName = customName ?? basename(absPath);
    } else if (content && content_type) {
      if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Content too large (${(content.length / 1024).toFixed(0)}KB). Inline content is capped at ${MAX_CONTENT_BYTES / 1024}KB to avoid burning tokens. Use the 'path' parameter instead — it reads from disk with zero token overhead.`,
            },
          ],
          isError: true,
        };
      }
      if (!customName) {
        return {
          content: [
            {
              type: "text" as const,
              text: "'name' is required when using 'content' mode (e.g. 'diagram.svg'). Auto-detected only with 'path'.",
            },
          ],
          isError: true,
        };
      }
      fileName = customName;
      fileMime = content_type;
      if (encoding === "raw") {
        fileBytes = new Uint8Array(Buffer.from(content));
      } else {
        fileBytes = new Uint8Array(Buffer.from(content, "base64"));
      }
    } else {
      return {
        content: [
          {
            type: "text" as const,
            text: "Provide either 'path' (file path on host) or 'content' + 'content_type' (base64/raw content).",
          },
        ],
        isError: true,
      };
    }

    const form = new FormData();
    form.append("file", new Blob([fileBytes], { type: fileMime }), fileName);

    const res = await fetch(`${GATEWAY_URL}/${fileName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [
          {
            type: "text" as const,
            text: `Upload failed (${res.status}): ${text}`,
          },
        ],
        isError: true,
      };
    }

    const data = (await res.json()) as {
      name: string;
      kind: string;
      bytes: number;
      permalink: string;
    };

    return {
      content: [
        {
          type: "resource_link" as const,
          uri: data.permalink,
          name: data.name,
          mimeType: data.kind,
        },
        {
          type: "text" as const,
          text: `Uploaded ${data.name} (${data.kind}, ${data.bytes} bytes)\n${data.permalink}`,
        },
      ],
    };
  },
);

// ─── upload_from_sandbox ────────────────────────────────────────────────────

server.registerTool(
  "upload_from_sandbox",
  {
    title: "Upload from Sandbox",
    description:
      "Upload a file from a sandbox/container path (e.g. /mnt/user-data/, /home/claude/) that the host cannot access. Reads the file and uploads it directly — single tool call, no shell commands needed.",
    inputSchema: z.object({
      sandbox_path: z
        .string()
        .describe(
          "Path to the file inside the sandbox (e.g. /mnt/user-data/uploads/photo.png)",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Custom name for the uploaded file. Defaults to the filename.",
        ),
    }),
    annotations: {
      title: "Upload from Sandbox",
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async ({ sandbox_path, name: customName }) => {
    if (!API_KEY) {
      return {
        content: [
          {
            type: "text" as const,
            text: "OBJEKT_API_KEY not set. Get a free key at objekt.sh/mcp",
          },
        ],
        isError: true,
      };
    }

    const fileName = customName ?? basename(sandbox_path);
    const fileMime = mimeFromPath(sandbox_path);

    let fileBytes: Uint8Array;
    try {
      const buffer = await readFile(sandbox_path);
      fileBytes = new Uint8Array(buffer);
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: `File not found or not readable: ${sandbox_path}`,
          },
        ],
        isError: true,
      };
    }

    const form = new FormData();
    form.append("file", new Blob([fileBytes], { type: fileMime }), fileName);

    const res = await fetch(`${GATEWAY_URL}/${fileName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [
          {
            type: "text" as const,
            text: `Upload failed (${res.status}): ${text}`,
          },
        ],
        isError: true,
      };
    }

    const data = (await res.json()) as {
      name: string;
      kind: string;
      bytes: number;
      permalink: string;
    };

    return {
      content: [
        {
          type: "resource_link" as const,
          uri: data.permalink,
          name: data.name,
          mimeType: data.kind,
        },
        {
          type: "text" as const,
          text: `Uploaded ${data.name} (${data.kind}, ${data.bytes} bytes)\n${data.permalink}`,
        },
      ],
    };
  },
);

// ─── get_file ───────────────────────────────────────────────────────────────

server.registerTool(
  "get_file",
  {
    title: "Get File",
    description:
      "Get a file from objekt.sh by name. Returns a link to the file without downloading the content.",
    inputSchema: z.object({
      name: z.string().describe("File name/key (e.g. 'photo.png')"),
    }),
    annotations: {
      title: "Get File",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ name }) => {
    const res = await fetch(`${GATEWAY_URL}/${name}`, {
      method: "HEAD",
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    });

    if (!res.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `File not found: ${name} (${res.status})`,
          },
        ],
        isError: true,
      };
    }

    const contentType =
      res.headers.get("content-type") ?? "application/octet-stream";
    const size = res.headers.get("content-length") ?? "unknown";
    const url = `${GATEWAY_URL}/${name}`;

    return {
      content: [
        {
          type: "resource_link" as const,
          uri: url,
          name,
          mimeType: contentType,
        },
        {
          type: "text" as const,
          text: `${name} — ${contentType}, ${size} bytes\n${url}`,
        },
      ],
    };
  },
);

// ─── get_pricing ────────────────────────────────────────────────────────────

server.registerTool(
  "get_pricing",
  {
    title: "Get Pricing",
    description: "Get current storage pricing and limits from objekt.sh.",
    inputSchema: z.object({}),
    annotations: {
      title: "Get Pricing",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const res = await fetch(`${GATEWAY_URL}/pricing`);

    if (!res.ok) {
      return {
        content: [{ type: "text" as const, text: "Failed to fetch pricing" }],
        isError: true,
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ─── check_connection ──────────────────────────────────────────────────────

server.registerTool(
  "check_connection",
  {
    title: "Check Connection",
    description:
      "Test connectivity to api.objekt.sh. Use this to diagnose sandbox egress issues. If it fails, the user needs to add api.objekt.sh to their domain allowlist (Settings → Capabilities → Domain Allowlist).",
    inputSchema: z.object({}),
    annotations: {
      title: "Check Connection",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const checks = {
      gateway: GATEWAY_URL,
      apiKey: API_KEY ? "set" : "missing",
      egress: "unknown" as string,
      latencyMs: 0,
    };

    const start = Date.now();
    try {
      const res = await fetch(`${GATEWAY_URL}/pricing`, {
        signal: AbortSignal.timeout(10_000),
      });
      checks.latencyMs = Date.now() - start;
      checks.egress = res.ok ? "ok" : `http_${res.status}`;
    } catch {
      checks.latencyMs = Date.now() - start;
      checks.egress = "blocked";
    }

    if (checks.egress === "blocked") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Cannot reach ${GATEWAY_URL}\n\nThis usually means network egress is blocked. To fix:\n1. Go to Settings → Capabilities\n2. Enable "Allow network egress"\n3. Under Domain Allowlist, add: api.objekt.sh\n\nAPI key: ${checks.apiKey}`,
          },
        ],
        isError: true,
      };
    }

    if (checks.apiKey === "missing") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Egress: ${checks.egress} (${checks.latencyMs}ms)\nAPI key: missing — set OBJEKT_API_KEY in your MCP server config. Get a key at objekt.sh/mcp`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Egress: ${checks.egress} (${checks.latencyMs}ms)\nGateway: ${checks.gateway}\nAPI key: ${checks.apiKey}`,
        },
      ],
    };
  },
);

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
