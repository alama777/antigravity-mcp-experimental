# 🛠 Antigravity MCP Installation Guide

> [!NOTE]
> **To AI Agents:** This document is written for both human developers and autonomous AI systems. If you are an AI reading this, follow the terminal commands exactly as written to install the extension, then refer to the configuration details to set up external AI clients if needed.

This guide describes the process of installing the extension in the Antigravity IDE and configuring the connection of external AI clients via `bin/stdio-proxy.mjs`.

## 📦 Prerequisites

* **Antigravity IDE**: Must be installed locally.
* **Node.js**: Required for running the external client proxy (`bin/stdio-proxy.mjs`) and for compiling the extension from source.
  * **Windows / macOS:** Download and install from the official site at [nodejs.org](https://nodejs.org/).
  * **Linux / macOS (CLI):** We recommend using Node Version Manager (nvm). Run `nvm install node` to get the latest version.

## Step 1: Installing the Server Extension

The server component is installed directly as a plugin inside the Antigravity editor. It runs a local HTTP server with SSE (Server-Sent Events) support on port `3033`.

There are three ways to install the extension, ranked by convenience:

### Option A: Open VSX Marketplace (Recommended)
You can directly install the extension from the official Open VSX registry.
[**View on Open VSX**](https://open-vsx.org/extension/alama777/antigravity-mcp-experimental)
*(In your IDE, simply open the Extensions tab and search for `alama777.antigravity-mcp-experimental @sort:name`).*

### Option B: Pre-built VSIX Package
Download the most up-to-date `.vsix` packet directly from our [**GitHub Releases page**](https://github.com/alama777/antigravity-mcp-experimental/releases).
You can install it via the IDE interface (`Extensions: Install from VSIX...`) or via the command line:
```bash
antigravity --install-extension /path/to/downloaded-package.vsix
```

### Option C: Manual Build (For Developers / AI Agents)
If you are developing or modifying the extension, you can build it from source locally.

**Installation Commands (Terminal execution):**

```bash
# 1. Navigate to the project directory
cd /path/to/antigravity-mcp-experimental

# 2. Install dependencies
npm install

# 3. Build the VSIX package
npm run package

# 4. Install the package using the Antigravity CLI
antigravity --install-extension builds/antigravity-mcp-experimental-*.vsix --force
```

**What `npm run package` does:**
It utilizes `vsce` to bundle everything (including critical `node_modules` like Express and the MCP SDK) into a single `.vsix` installer. Using the official `antigravity` CLI ensures the editor registers the plugin correctly in its internal `.json` registry, avoiding silent loading failures.

> [!IMPORTANT]
> **Recommended Startup Flag:** To enable full functionality (specifically reading chat history via `get_active_chat`), the Antigravity editor **MUST** be launched with the `--remote-debugging-port=9222` flag (e.g., run `antigravity --remote-debugging-port=9222` in your terminal). Without this flag, data extraction via CDP will fail, though basic prompt sending capabilities will remain functional.
>
> **Restart IDE:** After installing the extension, you must restart the editor to activate it.

---

## Zero-Config MCP Integration

The best part of this architecture is that **you do not need to configure the AI agent manually**.
When the Antigravity editor launches and the extension activates, it automatically discovers your `.gemini/antigravity/mcp_config.json` file and safely injects the standard `AntigravityMCP` server configuration pointing to its own packaged `stdio-proxy.mjs`.

Simply restart the IDE, and your internal AI clients will immediately have access to the session.

> **💡 Note:** The Zero-Config feature works specifically for Antigravity's internal Agent Manager. If you wish to connect an external app, proceed to Step 2.

---

## Step 2: External Client Configuration (e.g., Claude Desktop)

If you wish to connect an external app like **Claude Desktop**, you must manually configure it to use the packaged proxy script (`bin/stdio-proxy.mjs`).

For example, add the following to your `claude_desktop_config.json`:

```json
"mcpServers": {
  "antigravity-mcp": {
    "command": "node",
    "args": ["/absolute/path/to/antigravity-mcp-experimental/bin/stdio-proxy.mjs"]
  }
}
```

---

## 🗑️ Uninstalling

To completely remove the extension and its capabilities from your system:

1. Uninstall the **Antigravity MCP Server (Experimental)** extension from the IDE's Extensions view.
2. Remove the **AntigravityMCP** server entry from the *MCP Servers* settings section inside Antigravity.
