/**
 * A select that belongs to this app.
 *
 * The native `<select>` opens a platform popup: on macOS it is a white panel with
 * its own type, its own row height and its own idea of where the arrow goes. It
 * cannot be styled, and next to this page's tokens it reads as a different program.
 *
 * So: a button plus a listbox. What the native element gave for free has to be paid
 * for explicitly — keyboard navigation, type-ahead, ARIA roles, focus return, click
 * outside — and that is what the rest of this file is.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'

export type SelectOption = {
  value: string
  label: string
  hint?: string
}

type Props = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  id?: string
  ariaLabel?: string
  disabled?: boolean
}

export function Select({
  value,
  options,
  onChange,
  placeholder,
  id,
  ariaLabel,
  disabled,
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const typedRef = useRef({ text: '', at: 0 })
  const listId = useId()
  const optionId = (index: number): string => `${listId}-opt-${index}`

  const selected = useMemo(() => options.find((option) => option.value === value), [options, value])

  // Open at the current selection, not at the top: reopening a long list should
  // land where the person left it.
  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.findIndex((option) => option.value === value)))
  }, [open, options, value])

  // Click outside closes. `pointerdown` rather than `click`, so a click that starts
  // outside does not first open the list.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Keep the highlighted row inside the scroll box.
  useEffect(() => {
    if (!open) return
    const item = listRef.current?.children[active] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function commit(index: number): void {
    const option = options[index]
    if (option === undefined) return
    onChange(option.value)
    setOpen(false)
  }

  /** Type-ahead: typing "de" jumps to the first option starting with it. */
  function jumpByLetter(key: string): void {
    const now = Date.now()
    const state = typedRef.current
    state.text = now - state.at > 600 ? key : `${state.text}${key}`
    state.at = now
    const needle = state.text.toLowerCase()
    const index = options.findIndex((option) => option.label.toLowerCase().startsWith(needle))
    if (index >= 0) {
      setActive(index)
      if (!open) commit(index)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (options.length === 0) return
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) {
          setOpen(true)
          return
        }
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActive((current) => (current + delta + options.length) % options.length)
        return
      }
      case 'Home':
      case 'End':
        if (!open) return
        event.preventDefault()
        setActive(event.key === 'Home' ? 0 : options.length - 1)
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (open) commit(active)
        else setOpen(true)
        return
      case 'Escape':
        if (open) {
          event.preventDefault()
          setOpen(false)
        }
        return
      case 'Tab':
        setOpen(false)
        return
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) jumpByLetter(event.key)
    }
  }

  return (
    <div className="select" ref={rootRef}>
      <button
        id={id}
        type="button"
        className={`select__button ${open ? 'select__button--open' : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-activedescendant={open ? optionId(active) : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className={selected === undefined ? 'select__placeholder' : ''}>
          {selected?.label ?? placeholder ?? '请选择'}
        </span>
        <span className="select__chevron" aria-hidden="true" />
      </button>

      {open && (
        <ul className="select__list" role="listbox" id={listId} ref={listRef}>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              className={[
                'select__option',
                index === active ? 'select__option--active' : '',
                option.value === value ? 'select__option--selected' : '',
              ]
                .filter((part) => part !== '')
                .join(' ')}
              onPointerEnter={() => setActive(index)}
              // `pointerdown` + preventDefault keeps focus on the button, so the
              // keyboard handler keeps working after a mouse selection.
              onPointerDown={(event) => {
                event.preventDefault()
                commit(index)
              }}
            >
              <span>{option.label}</span>
              {option.hint !== undefined && <span className="select__hint">{option.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
