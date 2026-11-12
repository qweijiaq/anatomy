// Vendored copy of a three-function renderer. Kept for reference only: nothing in
// this fixture imports it, and the analysis scope must exclude the whole directory.
export function createElement(tag, props, ...children) {
  return { tag, props, children }
}

export function render(node) {
  return typeof node === 'string' ? node : node.tag
}
