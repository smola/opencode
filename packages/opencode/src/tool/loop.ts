import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./exit-loop.txt"
import { SessionLoop } from "@/session/loop"

export const ExitLoopTool = Tool.define("ExitLoop", {
  description: DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const reasons = await SessionLoop.reasons({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      agent: ctx.agent,
      messages: ctx.messages,
      abort: ctx.abort,
      ask: ctx.ask,
    })

    if (reasons.length) {
      return {
        title: "Exit denied",
        metadata: { approved: false, reasons },
        output: ["Exit denied. Continue working.", ...reasons.map((item) => `- ${item}`)].join("\n"),
      }
    }

    SessionLoop.allow(ctx.sessionID)
    return {
      title: "Exit approved",
      metadata: { approved: true, reasons: [] },
      output: "OK: Write your answer to the user.",
    }
  },
})
