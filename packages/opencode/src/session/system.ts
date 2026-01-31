import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import Handlebars from "handlebars"

import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_UNIFIED from "./prompt/unified.hbs"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission"
import { Skill } from "@/skill"
import { Flag } from "@/flag/flag"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"

const log = Log.create({ service: "system-prompt" })

const unifiedTemplate = Handlebars.compile(PROMPT_UNIFIED)

async function resolveRelativeInstruction(instruction: string): Promise<string[]> {
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.OPENCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR).catch(() => [])
}

export namespace SystemPrompt {
  export function instructions() {
    return unifiedTemplate({ isCodex: true, isAnthropic: false, isGemini: false }).trim()
  }

  export function provider(model: Provider.Model) {
    const isCodex = model.api.id.includes("gpt-5")
    const isGemini = model.api.id.includes("gemini-")
    const isAnthropic = model.api.id.includes("claude")

    if (isCodex || isGemini || isAnthropic) {
      return [unifiedTemplate({ isCodex, isGemini, isAnthropic })]
    }

    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_DEFAULT]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(agent: Agent.Info) {
    if (PermissionNext.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
