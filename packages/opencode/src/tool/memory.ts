import z from "zod"
import { Tool } from "./tool"
import { Memory } from "@/memory"
import GREP_DESCRIPTION from "./grepmemory.txt"
import READ_DESCRIPTION from "./readmemory.txt"
import WRITE_DESCRIPTION from "./writememory.txt"

function author(ctx: Tool.Context) {
  const model = ctx.extra?.model
  if (!model || typeof model !== "object") return "unknown/unknown"
  if (typeof model.providerID !== "string") return "unknown/unknown"
  if (typeof model.modelID === "string") return `${model.providerID}/${model.modelID}`
  if (typeof model.id === "string") return `${model.providerID}/${model.id}`
  if (typeof model.api === "object" && model.api && typeof model.api.id === "string") return `${model.providerID}/${model.api.id}`
  return "unknown/unknown"
}

export const ReadMemoryTool = Tool.define("ReadMemory", {
  description: READ_DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("Absolute memory path to a directory or memory card. Examples: /session/, /session/current/note.md, /workspace/current/, /global/note.md."),
  }),
  async execute(params, ctx) {
    const result = await Memory.read({ path: params.path, sessionID: ctx.sessionID })
    if ("entries" in result) {
      return {
        title: result.path,
        metadata: {},
        output: [`<path>${result.path}</path>`, `<type>directory</type>`, "<entries>", result.entries.join("\n"), "</entries>"].join("\n"),
      }
    }
    return {
      title: result.path,
      metadata: {},
      output: [`<path>${result.path}</path>`, `<type>memory</type>`, "<content>", result.content, "</content>"].join("\n"),
    }
  },
})

export const GrepMemoryTool = Tool.define("GrepMemory", {
  description: GREP_DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("Absolute memory path to search from. The path may point to a directory, memory card, or root alias such as /, /session/current, or /workspace/current."),
    pattern: z.string().describe("JavaScript regular expression source used to search memory card content."),
  }),
  async execute(params, ctx) {
    const result = await Memory.grep({ ...params, sessionID: ctx.sessionID })
    return {
      title: params.pattern,
      metadata: { matches: result.matches.length },
      output: result.output,
    }
  },
})

const WriteMemoryParams = z.object({
  path: z.string().describe("Absolute path to the memory card. WriteMemory only accepts writable aliases in the current scope: /session/current/<name>, /workspace/current/<name>, or /global/<name>. Do not write to /session/<timestamp-id>/... or /workspace/<workspace-path>/... ."),
  version: z.number().int().positive().describe("Version number for the write. Use 1 for a new card. For updates, read the card first and use the next version number."),
  description: z.string().describe("One sentence description of the memory."),
  content: z.string().describe("Markdown body content for the memory card."),
})

export const WriteMemoryTool = Tool.define("WriteMemory", {
  description: WRITE_DESCRIPTION,
  parameters: WriteMemoryParams,
  async execute(params, ctx) {
    const result = await Memory.write({
      ...params,
      sessionID: ctx.sessionID,
      author: author(ctx),
    })
    return {
      title: result.path,
      metadata: result,
      output: `Wrote memory ${result.path} version ${result.version}.`,
    }
  },
})
