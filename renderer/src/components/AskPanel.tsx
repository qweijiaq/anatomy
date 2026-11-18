/**
 * Follow-up questions on a finished report.
 *
 * Each answer is shown with the citations the model was allowed to make, and the
 * main process rejects any answer that cites a range the run did not store. The
 * panel says that a question costs a request before it is asked — a follow-up box
 * that silently bills the user is the MCP failure mode in a different surface.
 */

import { useState } from 'react'

import { api, type AskReply } from '../api.js'

type Exchange = {
  id: number
  question: string
  loading: boolean
  reply: AskReply | null
}

/** `path:start-end` inside prose becomes the same evidence button the report uses. */
function AnswerBody({
  text,
  onCite,
}: {
  text: string
  onCite: (path: string, lines: string) => void
}): React.JSX.Element {
  const parts = text.split(/(`?[A-Za-z0-9._@/-]+:\d+-\d+`?)/g)
  return (
    <p className="ask__answer">
      {parts.map((part, index) => {
        const match = /^`?(([A-Za-z0-9._@/-]+):(\d+-\d+))`?$/.exec(part)
        if (match === null) return <span key={index}>{part}</span>
        return (
          <button
            className="report__cite report__cite--action"
            key={index}
            type="button"
            title={`查看 ${part} 已存的原文片段`}
            onClick={() => onCite(match[2] as string, match[3] as string)}
          >
            {match[1]}
          </button>
        )
      })}
    </p>
  )
}

export function AskPanel({
  runId,
  onCite,
}: {
  runId: string
  onCite: (path: string, lines: string) => void
}): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<Exchange[]>([])
  const [asking, setAsking] = useState(false)

  async function submit(): Promise<void> {
    const text = question.trim()
    if (text === '' || asking) return
    const id = Date.now()
    setQuestion('')
    setAsking(true)
    setAsked((current) => [...current, { id, question: text, loading: true, reply: null }])
    let reply: AskReply
    try {
      reply = await api().report.ask(runId, text)
    } catch (failure) {
      reply = { ok: false, message: failure instanceof Error ? failure.message : String(failure) }
    }
    setAsked((current) =>
      current.map((item) => (item.id === id ? { ...item, loading: false, reply } : item)),
    )
    setAsking(false)
  }

  return (
    <section className="ask" aria-label="追问这份报告">
      <h2 className="ask__title">追问</h2>
      <p className="ask__lede">
        只根据这次分析已经存下来的证据回答；引用对不上就被丢弃。每次提问会花一次模型请求。
      </p>
      <form
        className="ask__form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <input
          className="input"
          value={question}
          placeholder="例如：为什么选这个方案，代价是什么？"
          spellCheck={false}
          disabled={asking}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={asking || question.trim() === ''}>
          {asking ? '回答中…' : '提问'}
        </button>
      </form>

      {asked.length > 0 && (
        <ol className="ask__list">
          {asked.map((item) => (
            <li className="ask__item" key={item.id}>
              <p className="ask__question">{item.question}</p>
              {item.loading ? (
                <p className="ask__pending">正在读这份报告的证据…</p>
              ) : item.reply === null ? (
                <p className="ask__error">没有收到回答。</p>
              ) : item.reply.ok ? (
                <>
                  {!item.reply.answered && (
                    <p className="ask__miss">报告里的证据不足以回答这个问题。</p>
                  )}
                  <AnswerBody text={item.reply.answer} onCite={onCite} />
                  <p className="ask__meta">
                    这次回答：输入 {item.reply.usage.in} / 输出 {item.reply.usage.out} tokens
                  </p>
                  {item.reply.citations.length > 0 && (
                    <p className="ask__cites">
                      {item.reply.citations.map((citation) => {
                        const split = citation.lastIndexOf(':')
                        return (
                          <button
                            className="report__cite report__cite--action"
                            key={citation}
                            type="button"
                            title={`查看 ${citation} 已存的原文片段`}
                            onClick={() => onCite(citation.slice(0, split), citation.slice(split + 1))}
                          >
                            {citation}
                          </button>
                        )
                      })}
                    </p>
                  )}
                </>
              ) : (
                <p className="ask__error">{item.reply.message}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
