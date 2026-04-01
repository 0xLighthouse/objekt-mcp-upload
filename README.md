# @objekt.sh/mcp-upload

MCP server for uploading files to decentralised storage from Claude Desktop, Cursor, or any MCP client.

## Setup

Get a free API key at [objekt.sh/mcp](https://objekt.sh/mcp), then add to your MCP config:

```json
{
  "mcpServers": {
    "objekt": {
      "command": "npx",
      "args": ["-y", "@objekt.sh/mcp-upload"],
      "env": {
        "OBJEKT_API_KEY": "objekt_mcp_..."
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `upload_file` | Upload by host path or inline content |
| `upload_from_sandbox` | Returns curl command for sandbox uploads |
| `get_file` | Get file metadata and permalink |
| `get_pricing` | Current storage tier pricing |

## Docs

[objekt.sh/mcp](https://objekt.sh/mcp) — setup, pricing, best practices.
