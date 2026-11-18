/**
 * What the window shows when a component throws.
 *
 * Without it a single undefined survey, a malformed artifact or a bad date turns the
 * whole window blank — the same surface as a crashed process, with no way to say
 * what happened or to get back. This boundary keeps the shell, prints the message,
 * and offers the two actions that help: copy the error, reload the page.
 *
 * It is the window's last line of defence, not a substitute for fixing the state
 * that threw.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { message: string; stack: string }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: '', stack: '' }

  static getDerivedStateFromError(error: unknown): State {
    return {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? '') : '',
    }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only place a developer can see the component stack after
    // the fact; it is not shown to the reader.
    console.error('anatomy: renderer error', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message === '') return this.props.children

    return (
      <div className="crash" role="alert">
        <div className="crash__body">
          <h1 className="crash__title">窗口遇到了一个错误</h1>
          <p className="crash__lede">
            界面停止渲染，但你的分析结果仍然在磁盘上。可以先复制这段信息，再重载窗口。
          </p>
          <pre className="crash__detail">{this.state.stack === '' ? this.state.message : this.state.stack}</pre>
          <div className="crash__actions">
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(`${this.state.message}\n\n${this.state.stack}`)
              }}
            >
              复制错误
            </button>
            <button className="btn btn--primary" type="button" onClick={() => window.location.reload()}>
              重载窗口
            </button>
          </div>
        </div>
      </div>
    )
  }
}
