// Fake peak hub for agent integration tests: accepts one agent, records its
// messages, and lets the test send commands.
import net from "node:net"
import { spawn } from "node:child_process"

export async function startHub() {
  const messages = []
  const waiters = []
  let socket = null
  let connected
  const ready = new Promise((r) => (connected = r))
  const server = net.createServer((s) => {
    socket = s
    connected(s)
    let buf = ""
    s.on("data", (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        messages.push(msg)
        for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
      }
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  return {
    addr: `127.0.0.1:${port}`,
    messages,
    ready,
    waitFor(pred, ms = 15000) {
      const hit = messages.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve }
        waiters.push(w)
        setTimeout(() => reject(new Error("timed out waiting for message")), ms).unref()
      })
    },
    async request(cmd, reqId) {
      await ready
      socket.write(JSON.stringify({ cmd, reqId }) + "\n")
      return this.waitFor((m) => m.type === "reply" && m.reqId === reqId, 60000)
    },
    close: () => new Promise((r) => { socket?.destroy(); server.close(r) }),
  }
}

export function run(bin, args, env) {
  const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] })
  child.stdout.resume()
  return child
}
