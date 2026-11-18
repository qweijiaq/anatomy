/**
 * One citation, read back from the run that produced it.
 *
 * The report promises that a claim's evidence resolves; the window could show the
 * location but not the bytes. The tree is gone by the time a report is read, but the
 * validator stored the exact snippet in `points.json`, so this panel answers the
 * question without re-reading (or guessing at) a source file.
 *
 * It is deliberately explicit that the snippet is stored evidence, not a live read:
 * a stale run should not look like a fresh check.
 */

import { useEffect, useRef } from 'react'
import type { EvidenceReply } from '../api.js'

export function EvidencePanel({
  where,
  loading,
  reply,
  onClose,
}: {
  /** `path:lines` as printed in the report. */
  where: string
  loading: boolean
  reply: EvidenceReply | null
  onClose: () => void
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  // The parent passes an inline handler; a ref keeps a re-render from stealing focus
  // back to the close button every time the snippet arrives.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="evidence" role="dialog" aria-modal="false" aria-label={`证据 ${where}`}>
      <header className="evidence__head">
        <div className="evidence__where">
          <span className="evidence__label">引用</span>
          <code className="inline-code">{where}</code>
        </div>
        <button ref={closeRef} className="btn btn--ghost btn--sm" type="button" onClick={onClose}>
          关闭
        </button>
      </header>

      {loading ? (
        <p className="evidence__note">正在读这次分析存下的证据…</p>
      ) : reply === null ? (
        <p className="evidence__note">没有读到证据。</p>
      ) : reply.ok ? (
        <>
          <p className="evidence__title">{reply.title}</p>
          <pre className="evidence__code">
            <code>{reply.snippet}</code>
          </pre>
          <p className="evidence__note">
            这是生成报告时存进这次分析的片段，已经过一次字节核对；它不是对当前源码的实时读取。
          </p>
        </>
      ) : (
        <p className="evidence__note evidence__note--error">{reply.message}</p>
      )}
    </div>
  )
}
