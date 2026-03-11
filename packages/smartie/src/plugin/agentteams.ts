import os from "os"
import path from "path"
import { tool, type Plugin } from "@smartie-code/plugin"
import { Process } from "@/util/process"

type RunResult = {
  code: number
  stdout: string
  stderr: string
}

function enabled() {
  const value = process.env["SMARTIE_AGENT_TEAMS"]?.toLowerCase()
  return value === "1" || value === "true"
}

function home() {
  return process.env.HOME || os.homedir()
}

function binpath() {
  return [path.join(home(), "go", "bin"), path.join(home(), ".local", "bin"), process.env.PATH ?? ""].join(":")
}

async function run(cmd: string[], cwd: string): Promise<RunResult> {
  const out = await Process.run(cmd, {
    cwd,
    env: {
      PATH: binpath(),
    },
    nothrow: true,
  })
  return {
    code: out.code,
    stdout: out.stdout.toString().trim(),
    stderr: out.stderr.toString().trim(),
  }
}

function first(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function convoy(text: string) {
  return text.match(/\b[a-z]+-[a-z0-9.-]+\b/i)?.[0] ?? first(text)
}

function reason(out: RunResult) {
  return out.stderr || out.stdout || "command failed without output"
}

function fallback(phase: string, reason: string) {
  return [
    `Agent Teams fallback: ${phase} failed.`,
    `Reason: ${reason}`,
    "Continue in the current session without creating a team.",
  ].join("\n")
}

function rig(cwd: string) {
  const configured = process.env["SMARTIE_AGENT_TEAMS_RIG"]?.trim()
  if (configured) return configured
  const match = cwd.match(/\/gt\/([^/]+)\//)
  return match?.[1] ?? "smartie_product"
}

function beadDescription(item: { acceptance: string; targets: string[] }) {
  return `Acceptance: ${item.acceptance} | Targets: ${item.targets.join(", ")}`
}

function beadId(text: string) {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed[0]?.id
    if (parsed && typeof parsed === "object" && "id" in parsed) return String(parsed.id)
  } catch {
    // Fall back to plain text extraction for older/noisy command output.
  }
  return convoy(text)
}

export const AgentTeamsPlugin: Plugin = async (input) => {
  if (!enabled()) return {}

  return {
    tool: {
      agent_team_create: tool({
        description:
          "Create an Agent Team convoy with beads for an explicitly requested team or a complex task you decide should be decomposed into parallel sub-tasks. If creation or dispatch fails, this tool falls back to single-session execution instead of aborting.",
        args: {
          goal: tool.schema.string().describe("The overall task or outcome for the team."),
          reason: tool.schema
            .string()
            .describe("Why parallel execution is useful, for example independent files or clear sub-problems."),
          tasks: tool.schema
            .array(
              tool.schema.object({
                description: tool.schema.string().describe("A short bead title."),
                acceptance: tool.schema.string().describe("Concrete acceptance criteria for this bead."),
                targets: tool.schema
                  .array(tool.schema.string())
                  .describe("Files, modules, or areas this bead should target."),
              }),
            )
            .min(1)
            .describe("Independent sub-tasks for the convoy."),
        },
        async execute(args, ctx) {
          const created: string[] = []
          for (const item of args.tasks) {
            const bead = await run(
              [
                "bd",
                "create",
                "--title",
                item.description,
                "--description",
                beadDescription(item),
                "--type",
                "task",
                "--priority",
                "2",
                "--json",
              ],
              input.directory,
            )
            if (bead.code !== 0) return fallback("bead creation", reason(bead))
            const id = beadId(bead.stdout)
            if (!id) return fallback("bead creation", "bead id missing from bd create output")
            created.push(id)
          }

          if (!created.length) return fallback("bead creation", "no bead ids were created")

          const makeConvoy = await run(["gt", "convoy", "create", args.goal, created[0]!], input.directory)
          if (makeConvoy.code !== 0) return fallback("convoy creation", reason(makeConvoy))

          const convoyID = convoy(makeConvoy.stdout)
          if (!convoyID) return fallback("convoy creation", "convoy id missing from gt convoy create output")

          if (created.length > 1) {
            const add = await run(["gt", "convoy", "add", convoyID, ...created.slice(1)], input.directory)
            if (add.code !== 0) return fallback("convoy add", reason(add))
          }

          const dispatch = await run(
            ["gt", "sling", ...created, rig(input.directory), "--no-convoy", "--max-concurrent", String(created.length)],
            input.directory,
          )
          if (dispatch.code !== 0) return fallback("dispatch", reason(dispatch))

          return [
            `Created Agent Team convoy ${convoyID}.`,
            `Reason: ${args.reason}`,
            created.length ? `Beads: ${created.join(", ")}` : "Beads: created",
            `Dispatched convoy ${convoyID} to ${rig(input.directory)}.`,
          ].join("\n")
        },
      }),
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(
        [
          "Agent Teams are enabled for this session.",
          "If the user explicitly asks to create an agent team, convoy, or beads, you may use the agent_team_create tool.",
          "You may also propose and use agent_team_create on your own when the task decomposes into independent parallel sub-tasks with clear file or module boundaries.",
          "Only create teams when the work can be split cleanly. If the tool reports fallback, continue in the current session without retrying orchestration.",
        ].join("\n"),
      )
    },
  }
}
