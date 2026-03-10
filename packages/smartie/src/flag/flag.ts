function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const SMARTIE_AUTO_SHARE = truthy("SMARTIE_AUTO_SHARE")
  export const SMARTIE_GIT_BASH_PATH = process.env["SMARTIE_GIT_BASH_PATH"]
  export const SMARTIE_CONFIG = process.env["SMARTIE_CONFIG"]
  export declare const SMARTIE_TUI_CONFIG: string | undefined
  export declare const SMARTIE_CONFIG_DIR: string | undefined
  export const SMARTIE_CONFIG_CONTENT = process.env["SMARTIE_CONFIG_CONTENT"]
  export const SMARTIE_DISABLE_AUTOUPDATE = truthy("SMARTIE_DISABLE_AUTOUPDATE")
  export const SMARTIE_DISABLE_PRUNE = truthy("SMARTIE_DISABLE_PRUNE")
  export const SMARTIE_DISABLE_TERMINAL_TITLE = truthy("SMARTIE_DISABLE_TERMINAL_TITLE")
  export const SMARTIE_PERMISSION = process.env["SMARTIE_PERMISSION"]
  export const SMARTIE_DISABLE_DEFAULT_PLUGINS = truthy("SMARTIE_DISABLE_DEFAULT_PLUGINS")
  export const SMARTIE_DISABLE_LSP_DOWNLOAD = truthy("SMARTIE_DISABLE_LSP_DOWNLOAD")
  export const SMARTIE_ENABLE_EXPERIMENTAL_MODELS = truthy("SMARTIE_ENABLE_EXPERIMENTAL_MODELS")
  export const SMARTIE_DISABLE_AUTOCOMPACT = truthy("SMARTIE_DISABLE_AUTOCOMPACT")
  export const SMARTIE_DISABLE_MODELS_FETCH = truthy("SMARTIE_DISABLE_MODELS_FETCH")
  export const SMARTIE_DISABLE_CLAUDE_CODE = truthy("SMARTIE_DISABLE_CLAUDE_CODE")
  export const SMARTIE_DISABLE_CLAUDE_CODE_PROMPT =
    SMARTIE_DISABLE_CLAUDE_CODE || truthy("SMARTIE_DISABLE_CLAUDE_CODE_PROMPT")
  export const SMARTIE_DISABLE_CLAUDE_CODE_SKILLS =
    SMARTIE_DISABLE_CLAUDE_CODE || truthy("SMARTIE_DISABLE_CLAUDE_CODE_SKILLS")
  export const SMARTIE_DISABLE_EXTERNAL_SKILLS =
    SMARTIE_DISABLE_CLAUDE_CODE_SKILLS || truthy("SMARTIE_DISABLE_EXTERNAL_SKILLS")
  export declare const SMARTIE_DISABLE_PROJECT_CONFIG: boolean
  export const SMARTIE_FAKE_VCS = process.env["SMARTIE_FAKE_VCS"]
  export declare const SMARTIE_CLIENT: string
  export const SMARTIE_SERVER_PASSWORD = process.env["SMARTIE_SERVER_PASSWORD"]
  export const SMARTIE_SERVER_USERNAME = process.env["SMARTIE_SERVER_USERNAME"]
  export const SMARTIE_ENABLE_QUESTION_TOOL = truthy("SMARTIE_ENABLE_QUESTION_TOOL")

  // Experimental
  export const SMARTIE_EXPERIMENTAL = truthy("SMARTIE_EXPERIMENTAL")
  export const SMARTIE_EXPERIMENTAL_FILEWATCHER = truthy("SMARTIE_EXPERIMENTAL_FILEWATCHER")
  export const SMARTIE_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("SMARTIE_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const SMARTIE_EXPERIMENTAL_ICON_DISCOVERY =
    SMARTIE_EXPERIMENTAL || truthy("SMARTIE_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["SMARTIE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const SMARTIE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("SMARTIE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const SMARTIE_ENABLE_EXA =
    truthy("SMARTIE_ENABLE_EXA") || SMARTIE_EXPERIMENTAL || truthy("SMARTIE_EXPERIMENTAL_EXA")
  export const SMARTIE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("SMARTIE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const SMARTIE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("SMARTIE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const SMARTIE_EXPERIMENTAL_OXFMT = SMARTIE_EXPERIMENTAL || truthy("SMARTIE_EXPERIMENTAL_OXFMT")
  export const SMARTIE_EXPERIMENTAL_LSP_TY = truthy("SMARTIE_EXPERIMENTAL_LSP_TY")
  export const SMARTIE_EXPERIMENTAL_LSP_TOOL = SMARTIE_EXPERIMENTAL || truthy("SMARTIE_EXPERIMENTAL_LSP_TOOL")
  export const SMARTIE_DISABLE_FILETIME_CHECK = truthy("SMARTIE_DISABLE_FILETIME_CHECK")
  export const SMARTIE_EXPERIMENTAL_PLAN_MODE = SMARTIE_EXPERIMENTAL || truthy("SMARTIE_EXPERIMENTAL_PLAN_MODE")
  export const SMARTIE_EXPERIMENTAL_WORKSPACES = SMARTIE_EXPERIMENTAL || truthy("SMARTIE_EXPERIMENTAL_WORKSPACES")
  export const SMARTIE_EXPERIMENTAL_MARKDOWN = !falsy("SMARTIE_EXPERIMENTAL_MARKDOWN")
  export const SMARTIE_MODELS_URL = process.env["SMARTIE_MODELS_URL"]
  export const SMARTIE_MODELS_PATH = process.env["SMARTIE_MODELS_PATH"]
  export const SMARTIE_DISABLE_CHANNEL_DB = truthy("SMARTIE_DISABLE_CHANNEL_DB")
  export const SMARTIE_SKIP_MIGRATIONS = truthy("SMARTIE_SKIP_MIGRATIONS")

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for SMARTIE_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "SMARTIE_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("SMARTIE_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for SMARTIE_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "SMARTIE_TUI_CONFIG", {
  get() {
    return process.env["SMARTIE_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for SMARTIE_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "SMARTIE_CONFIG_DIR", {
  get() {
    return process.env["SMARTIE_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for SMARTIE_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "SMARTIE_CLIENT", {
  get() {
    return process.env["SMARTIE_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
