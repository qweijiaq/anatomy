/// <reference types="vite/client" />
import type React from 'react'

declare global {
  namespace React {
    // The project does not import React's JSX namespace explicitly; Vite's esbuild
    // transform uses the automatic runtime, so a bare `React.JSX.Element` return
    // type is enough.
  }
}
