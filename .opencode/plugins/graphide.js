// Graphide agent signals for OpenCode: runs .graphide/agent-signal.sh in the
// background when a session starts or ends, on each prompt and after each
// tool, so Graphide CI has machines ready before a push lands. It never waits
// on the script and never throws, but for one call: before Graphide's
// ci_run_tests MCP tool it waits (at most 20 s) for the script to push the
// commit to test to a hidden ref. Off: GRAPHIDE_SIGNALS=off, or a
// .graphide/signals-off file.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const GraphideAgentSignals = async ({ directory, worktree }) => {
  const root = worktree || directory
  const script = join(root, ".graphide", "agent-signal.sh")
  const calls = new Map()
  const signal = (event, input) => {
    try {
      if (!existsSync(script)) return
      const child = spawn("sh", [script, event, "opencode"], {
        cwd: root,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      })
      child.on("error", () => {})
      child.stdin.on("error", () => {})
      child.stdin.end(JSON.stringify(input))
      child.unref()
    } catch {}
  }
  // runPrep pushes the commit a ci_run_tests call names (else HEAD) before
  // the call goes out; it resolves when the script ends or after 20 s.
  const runPrep = (input, output) =>
    new Promise((resolve) => {
      try {
        if (!existsSync(script)) return resolve()
        const timer = setTimeout(resolve, 20000)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        const child = spawn("sh", [script, "run-prep", "opencode"], { cwd: root, stdio: ["pipe", "ignore", "ignore"] })
        child.on("error", done)
        child.on("exit", done)
        child.stdin.on("error", () => {})
        child.stdin.end(JSON.stringify({ session_id: input?.sessionID, tool_name: input?.tool, tool_input: output?.args ?? {} }))
      } catch {
        resolve()
      }
    })
  return {
    event: async ({ event }) => {
      const id = event?.properties?.info?.id
      if (event?.type === "session.created") signal("start", { session_id: id })
      else if (event?.type === "session.deleted") signal("end", { session_id: id })
    },
    "chat.message": async (input) => {
      signal("prompt", { session_id: input?.sessionID })
    },
    "tool.execute.before": async (input, output) => {
      if (/ci_run_tests$/.test(String(input?.tool ?? ""))) await runPrep(input, output)
      const { command, filePath, patchText } = output?.args ?? {}
      const edits = /edit|write|patch/i.test(String(input?.tool ?? ""))
      if (typeof command === "string") calls.set(input?.callID, { shell: { command } })
      else if (edits && typeof filePath === "string") calls.set(input?.callID, { edit: { file_path: filePath } })
      else if (edits && typeof patchText === "string") calls.set(input?.callID, { edit: { patch: patchText } })
    },
    "tool.execute.after": async (input) => {
      const call = calls.get(input?.callID)
      calls.delete(input?.callID)
      const payload = { session_id: input?.sessionID, tool_name: input?.tool }
      if (call?.shell) signal("shell", { ...payload, tool_input: call.shell })
      else if (call?.edit) signal("edit", { ...payload, tool_input: call.edit })
      else signal("tool", payload)
    },
  }
}
