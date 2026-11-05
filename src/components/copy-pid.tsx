import { useEffect, useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

/** Click-to-copy PID. */
export function CopyPid({ pid, label = true, className }: { pid: number; label?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(pid))
      setCopied(true)
    } catch {
      toast.error("Couldn't copy PID")
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy PID"
      aria-label={`Copy PID ${pid}`}
      className={cn(
        "group/pid inline-flex items-center gap-1 rounded-md tabular-nums transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground",
        className,
      )}
    >
      {label && "PID "}
      {pid}
      {copied ? (
        <CheckIcon className="size-3 text-success" />
      ) : (
        <CopyIcon className="size-3 opacity-0 transition-opacity group-hover/pid:opacity-60" />
      )}
    </button>
  )
}
