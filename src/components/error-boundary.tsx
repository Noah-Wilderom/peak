import { Component, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

/** Keeps a render error in one view from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg rounded-card bg-secondary p-8">
          <h2 className="text-title">Something went wrong in this view.</h2>
          <pre className="mt-3 overflow-auto rounded-2xl bg-background p-4 font-mono text-xs whitespace-pre-wrap text-muted-foreground select-text">
            {this.state.error.message}
          </pre>
          <Button className="mt-4" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
}
