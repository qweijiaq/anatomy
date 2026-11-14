// A local stand-in for REA, used by `scripts/verify.sh` so the no-source half of the
// product can be exercised offline.
//
// Why it exists: `inspect-app`, `app-report` and `app-diff` were the only commands in
// the CLI that the gate never ran. Their unit tests feed fixtures straight into the
// adapters, so nothing ever executed the path a user takes — locate REA, spawn it,
// read progress off stderr, parse the document, write the evidence file, render the
// pages. That is the same shape as the model stub: a deterministic answer, in the real
// protocol, so the rest of the pipeline is what gets tested.
//
// It answers one command, `analyze-javascript-application <target> --json`, and it
// emits the fields the adapter actually reads — see `surveyApplication` in
// `src/app/rea.ts`, which is the only consumer.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const target = argv[1] ?? ''

if (!argv.includes('analyze-javascript-application') || target === '') {
  process.stderr.write('rea-stub: expected `analyze-javascript-application <target> --json`\n')
  process.exit(2)
}

/** Progress lines, in REA's own `{"rea_progress": …}` shape and wording. */
const steps = [
  'Reading the bundle manifest',
  'Parsing main.js (1/3)',
  'Parsing preload.js (2/3)',
  'Parsing renderer.js (3/3)',
]
for (const message of steps) {
  process.stderr.write(`${JSON.stringify({ rea_progress: { phase: 'analyse', message } })}\n`)
}

// A fixed digest: the same tree must produce the same evidence, or `app-diff` of a
// directory against itself would report a change.
const digest = createHash('sha256').update('anatomy-rea-stub').digest('hex')

const document = {
  evidence_id: 'rea-stub-0001',
  confidence: 'high',
  authority: 'observed',
  subject: { dir: target, name: 'stub-app', format: 'directory', digest: { sha256: digest } },
  normalized_result: {
    summary: {
      browser_windows: 1,
      preload_entrypoints: 1,
      context_bridge_apis: 1,
      // One more exposed member when the tree carries `extra.js`: the gate compares two
      // builds, and a diff of two identical surveys exercises only the empty branch.
      exposed_api_members: 5 + (existsSync(path.join(target, 'extra.js')) ? 1 : 0),
      sender_validation_observations: 2,
      native_addon_bindings: 0,
      protocol_registrations: 1,
      electron_semantics: 'static',
      ipc: {
        operations: 4,
        literal_channels: 2,
        main_handlers: 3,
        renderer_transmissions: 4,
        renderer_listeners: 2,
        ambiguous_renderer_transmissions: 1,
      },
    },
    statistics: {
      relevant_files: 6,
      parsed_javascript_files: 3,
      visited_ast_nodes: 1200,
      findings: 4,
    },
    limitations: ['the stub reports what a stub can see'],
    graph: {
      nodes: [
        { node_id: 'n1', kind: 'ipc-channel', identity: { key: 'files:read' } },
        { node_id: 'n2', kind: 'ipc-channel', identity: { key: 'files:write' } },
        { node_id: 'n3', kind: 'context-bridge-api', identity: { key: 'api' }, members: ['read', 'write'] },
      ],
      edges: [{ from: 'n3', to: 'n1', relation: 'handles' }],
    },
  },
}

process.stdout.write(JSON.stringify(document))
