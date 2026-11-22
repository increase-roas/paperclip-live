import * as React from "react"

type ModalFocusHandler = (event: Event) => void

/** Element that opened a controlled modal, captured before its content mounts. */
const ModalReturnFocusContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null)

/**
 * Radix restores focus to a `Dialog.Trigger`. Controlled modals often open
 * from a plain button, so Radix finds no trigger and focus falls to `<body>`.
 *
 * Capture the focused control while the root renders the closed -> open
 * transition. A layout effect is too late: React's `autoFocus` and Radix's
 * focus scope move focus inside the modal during commit.
 */
export function useModalReturnFocusTarget(open: boolean | undefined) {
  const targetRef = React.useRef<HTMLElement | null>(null)
  const wasOpenRef = React.useRef(false)
  if (open && !wasOpenRef.current && typeof document !== "undefined") {
    const active = document.activeElement
    targetRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null
  }
  wasOpenRef.current = Boolean(open)
  return targetRef
}

export function ModalReturnFocusProvider({
  target,
  children,
}: {
  target: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}) {
  return (
    <ModalReturnFocusContext.Provider value={target}>
      {children}
    </ModalReturnFocusContext.Provider>
  )
}

/** Compose the return-focus behavior with a caller's close handler. */
export function useModalReturnFocus({
  onCloseAutoFocus,
}: {
  onCloseAutoFocus?: ModalFocusHandler
} = {}) {
  const targetRef = React.useContext(ModalReturnFocusContext)

  const handleCloseAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event)
      if (event.defaultPrevented) return
      const target = targetRef?.current
      if (target?.isConnected) {
        event.preventDefault()
        target.focus()
      }
    },
    [onCloseAutoFocus, targetRef]
  )

  return { onCloseAutoFocus: handleCloseAutoFocus }
}
