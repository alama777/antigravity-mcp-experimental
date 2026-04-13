# 🛠 Antigravity MCP Installation Guide

> [!NOTE]
> **To AI Agents:** This document is written for both human developers and autonomous AI systems. If you are an AI reading this, follow the terminal commands exactly as written to install the extension, then configure your own MCP settings using the provided JSON template.

This guide describes the process of installing the extension in the Antigravity IDE and configuring the connection of external AI clients via `bin/stdio-proxy.mjs`.

## Step 1: Installing the Server Extension

The server component is installed directly as a plugin inside the Antigravity editor. It runs a local HTTP server with SSE (Server-Sent Events) support on port `3033`.

### 💻 Installation Commands (Terminal execution):

```bash
# 1. Navigate to the project directory
cd /path/to/antigravity-mcp-experimental

# 2. Install dependencies
npm install

# 3. Build the VSIX package
npm run package

# 4. Install the package using the Antigravity CLI
antigravity --install-extension builds/antigravity-mcp-experimental-0.0.1.vsix --force
```

**What `npm run package` does:**
It utilizes `vsce` to bundle everything (including critical `node_modules` like Express and the MCP SDK) into a single `.vsix` installer. Using the official `antigravity` CLI ensures the editor registers the plugin correctly in its internal `.json` registry, avoiding silent loading failures.

> [!IMPORTANT]
> **Mandatory Startup Flag:** For the extension to work, the Antigravity editor **MUST** be launched with the `--remote-debugging-port=9222` flag (e.g., run `antigravity --remote-debugging-port=9222` in your terminal). Without this flag, data extraction via CDP will fail.
>
> **Restart IDE:** After installing the extension, you must restart the editor (with the flag mentioned above) to activate it.

---

## Zero-Config MCP Integration

The best part of this architecture is that **you do not need to configure the AI agent manually**.
When the Antigravity editor launches and the extension activates, it automatically discovers your `.gemini/antigravity/mcp_config.json` file and safely injects the standard `AntigravityMCP` server configuration pointing to its own packaged `stdio-proxy.mjs`.

Simply restart the IDE, and your AI clients will immediately have access to the Antigravity session.
