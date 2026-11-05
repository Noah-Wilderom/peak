import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Proc } from "@/lib/types"
import { CopyPid } from "@/components/copy-pid"
import { formatBytes, formatPercent } from "@/lib/format"

export function ChildrenTable({ proc }: { proc: Proc }) {
  const last = proc.samples.at(-1)!
  const running = proc.status === "running"
  const rows = [
    { pid: proc.pid, name: proc.command, cpu: running ? last.cpu : 0, rss: running ? last.rss : 0, depth: 0 },
    ...proc.children.map((c) => ({ ...c, depth: 1 })),
  ]
  const maxRss = Math.max(...rows.map((r) => r.rss), 1)

  return (
    <div className="overflow-hidden rounded-card border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-secondary hover:bg-secondary">
            <TableHead className="w-24 pl-5 text-xs text-muted-foreground">PID</TableHead>
            <TableHead className="text-xs text-muted-foreground">Command</TableHead>
            <TableHead className="w-28 text-right text-xs text-muted-foreground">CPU</TableHead>
            <TableHead className="w-64 pr-5 text-xs text-muted-foreground">Memory</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.pid} className="hover:bg-secondary/50">
              <TableCell className="pl-5 font-mono text-xs text-muted-foreground">
                <CopyPid pid={r.pid} label={false} />
              </TableCell>
              <TableCell className="font-mono text-[12.5px]">
                {r.depth > 0 && <span className="mr-2 text-faint">└</span>}
                {r.name}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">{running ? formatPercent(r.cpu) : "—"}</TableCell>
              <TableCell className="pr-5">
                <div className="flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out"
                      style={{ width: `${(r.rss / maxRss) * 100}%` }}
                    />
                  </div>
                  <span className="w-16 text-right text-sm tabular-nums">{running ? formatBytes(r.rss) : "—"}</span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!running && (
        <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
          The process tree was torn down when the process ended.
        </p>
      )}
    </div>
  )
}
