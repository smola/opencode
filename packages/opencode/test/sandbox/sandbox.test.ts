import { describe, expect, test } from "bun:test"
import { spawn as childSpawn, type ChildProcess } from "child_process"
import fs from "fs/promises"
import type { Agent } from "../../src/agent/agent"
import { sandboxCommand, sandboxConfig, spawn } from "../../src/sandbox/sandbox"

const hasSandbox = process.platform === "linux" && !!Bun.which("bwrap")
const hasRunnableSandbox = (() => {
  if (!hasSandbox) return false
  const bwrap = Bun.which("bwrap")
  if (!bwrap) return false
  const probe = Bun.spawnSync([
    bwrap,
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--bind",
    "/",
    "/",
    "--chdir",
    "/tmp",
    "/bin/sh",
    "-c",
    "true",
  ])
  return probe.exitCode === 0
})()

async function output(proc: ChildProcess) {
  let out = ""
  let err = ""
  proc.stdout?.on("data", (chunk) => {
    out += chunk.toString()
  })
  proc.stderr?.on("data", (chunk) => {
    err += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject)
    proc.once("exit", resolve)
  })
  return { out, err, code }
}

describe("sandboxConfig", () => {
  test("parses valid sandbox config", () => {
    const config = sandboxConfig({
      options: {
        sandbox: {
          enabled: true,
          "read-only": true,
          network: false,
        },
      },
    } as unknown as Agent.Info)
    expect(config).toEqual({ enabled: true, "read-only": true, network: false })
  })

  test("returns undefined for unknown sandbox keys", () => {
    const config = sandboxConfig({
      options: {
        sandbox: {
          enabled: true,
          invalid: true,
        },
      },
    } as unknown as Agent.Info)
    expect(config).toBeUndefined()
  })

  test("returns undefined for invalid sandbox values", () => {
    const config = sandboxConfig({
      options: {
        sandbox: {
          enabled: "yes",
        },
      },
    } as unknown as Agent.Info)
    expect(config).toBeUndefined()
  })
})

describe("sandboxCommand", () => {
  test("returns undefined when sandbox is disabled", () => {
    const result = sandboxCommand({
      sandbox: { enabled: false, "read-only": true, network: false },
      shell: "/bin/bash",
      command: "echo hello",
      cwd: "/tmp",
    })
    expect(result).toBeUndefined()
  })

  ;(hasSandbox ? test.skip : test)("returns undefined when sandboxing is unavailable", () => {
    const result = sandboxCommand({
      sandbox: { enabled: true, "read-only": true, network: false },
      shell: "/bin/bash",
      command: "echo hello",
      cwd: "/tmp",
    })
    expect(result).toBeUndefined()
  })

  ;(hasSandbox ? test : test.skip)("builds read-only bubblewrap command", () => {
    const bwrap = Bun.which("bwrap")
    if (!bwrap) throw new Error("bwrap not found")
    const result = sandboxCommand({
      sandbox: { enabled: true, "read-only": true, network: false },
      shell: "/bin/bash",
      command: "echo hello",
      cwd: "/tmp",
    })
    expect(result).toBeDefined()
    expect(result?.command).toBe(bwrap)
    expect(result?.args).toContain("--ro-bind")
    expect(result?.args).toContain("--unshare-net")
    expect(result?.args).toEqual(expect.arrayContaining(["--chdir", "/tmp", "/bin/bash", "-lc", "echo hello"]))
  })

  ;(hasSandbox ? test : test.skip)("builds writable bubblewrap command when read-only is false", () => {
    const result = sandboxCommand({
      sandbox: { enabled: true, "read-only": false, network: true },
      shell: "/bin/bash",
      command: "echo hello",
      cwd: "/tmp",
    })
    expect(result).toBeDefined()
    expect(result?.args).toContain("--bind")
    expect(result?.args).not.toContain("--ro-bind")
    expect(result?.args).not.toContain("--unshare-net")
  })
})

describe("spawn", () => {
  test("executes command without sandbox", async () => {
    const proc = spawn("echo hello", {
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    const result = await output(proc)
    expect(result.code).toBe(0)
    expect(result.out).toContain("hello")
    expect(result.err).toBe("")
  })

  ;(hasSandbox ? test.skip : test)("falls back to normal spawn when sandbox is unavailable", async () => {
    const proc = spawn(
      "echo hello",
      {
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
      { enabled: true, "read-only": true, network: false },
    )
    const result = await output(proc)
    expect(result.code).toBe(0)
    expect(result.out).toContain("hello")
    expect(result.err).toBe("")
  })

  ;(hasRunnableSandbox ? test : test.skip)("fails to write in read-only sandbox", async () => {
    const file = `/tmp/opencode-sandbox-read-only-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await fs.rm(file, { force: true }).catch(() => {})
    const sandboxed = sandboxCommand({
      sandbox: { enabled: true, "read-only": true, network: true },
      shell: "/bin/sh",
      command: `touch ${file}`,
      cwd: process.cwd(),
    })
    if (!sandboxed) throw new Error("sandbox not available")
    const args = sandboxed.args.map((arg) => (arg === "-lc" ? "-c" : arg))
    const proc = childSpawn(sandboxed.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })
    const result = await output(proc)
    expect(result.code).not.toBe(0)
    await expect(fs.access(file)).rejects.toBeDefined()
  })

  ;(hasRunnableSandbox ? test : test.skip)("can write to /dev/null in read-only sandbox", async () => {
    const sandboxed = sandboxCommand({
      sandbox: { enabled: true, "read-only": true, network: true },
      shell: "/bin/sh",
      command: "echo hello > /dev/null",
      cwd: process.cwd(),
    })
    if (!sandboxed) throw new Error("sandbox not available")
    const args = sandboxed.args.map((arg) => (arg === "-lc" ? "-c" : arg))
    const proc = childSpawn(sandboxed.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })
    const result = await output(proc)
    expect(result.code).toBe(0)
  })

  ;(hasRunnableSandbox ? test : test.skip)("can write in sandbox when read-only is false", async () => {
    const file = `/tmp/opencode-sandbox-writable-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await fs.rm(file, { force: true }).catch(() => {})
    const sandboxed = sandboxCommand({
      sandbox: { enabled: true, "read-only": false, network: true },
      shell: "/bin/sh",
      command: `touch ${file}`,
      cwd: process.cwd(),
    })
    if (!sandboxed) throw new Error("sandbox not available")
    const args = sandboxed.args.map((arg) => (arg === "-lc" ? "-c" : arg))
    const proc = childSpawn(sandboxed.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })
    const result = await output(proc)
    expect(result.code).toBe(0)
    await expect(fs.access(file)).resolves.toBeNull()
    await fs.rm(file, { force: true })
  })
})
