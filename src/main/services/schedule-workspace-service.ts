import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathExists } from './workspace-paths'

const execFileAsync = promisify(execFile)
const AGENTS_FILE_NAME = 'AGENTS.md'
const DEFAULT_TASK_WORKTREE_DIR = '.deepseekgui/task-workspaces'
const GLOBAL_RULE_CANDIDATES = [
  join(homedir(), AGENTS_FILE_NAME),
  join(homedir(), '.codex', AGENTS_FILE_NAME),
  join(homedir(), '.kun', AGENTS_FILE_NAME)
]

export type TaskRuleDocument = {
  path: string
  content: string
}

export type TaskRuleLoadResult = {
  root: string
  sources: string[]
  documents: TaskRuleDocument[]
  text: string
}

export type TaskWorkspaceKind = 'git-worktree' | 'snapshot' | 'workspace'

export type TaskWorkspacePrepareResult = {
  kind: TaskWorkspaceKind
  sourceRoot: string
  repoRoot: string
  workspaceRoot: string
  ref?: string
  created: boolean
}

async function runGit(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024
  })
  return String(stdout).trim()
}

async function findGitRoot(workspaceRoot: string): Promise<string | null> {
  try {
    const root = await runGit(workspaceRoot, ['rev-parse', '--show-toplevel'])
    return root || null
  } catch {
    return null
  }
}

function normalizeRoot(root: string): string {
  return resolve(root.trim())
}

function taskWorkspaceDir(repoRoot: string): string {
  return join(repoRoot, DEFAULT_TASK_WORKTREE_DIR)
}

function slug(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'task'
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function listAgentsDocs(root: string): Promise<string[]> {
  const docs: string[] = []
  for (const global of GLOBAL_RULE_CANDIDATES) {
    if (await pathExists(global)) docs.push(global)
  }
  let current = normalizeRoot(root)
  let previous = ''
  while (current && current !== previous) {
    const direct = join(current, AGENTS_FILE_NAME)
    if (await pathExists(direct)) docs.push(direct)
    previous = current
    current = dirname(current)
  }
  return docs.reverse()
}

async function readTaskRuleText(files: string[]): Promise<TaskRuleDocument[]> {
  const docs: TaskRuleDocument[] = []
  for (const file of files) {
    try {
      docs.push({
        path: file,
        content: await readFile(file, 'utf8')
      })
    } catch {
      /* ignore unreadable rules */
    }
  }
  return docs
}

function buildRuleText(documents: TaskRuleDocument[]): string {
  return documents.map((doc) => {
    const name = doc.path.replace(/\\/g, '/')
    return `[# ${name}]\n${doc.content.trim()}`.trim()
  }).filter(Boolean).join('\n\n---\n\n')
}

export async function loadTaskRules(workspaceRoot: string): Promise<TaskRuleLoadResult> {
  const root = normalizeRoot(workspaceRoot)
  const sources = await listAgentsDocs(root)
  const documents = await readTaskRuleText(sources)
  return {
    root,
    sources,
    documents,
    text: buildRuleText(documents)
  }
}

async function uniqueGitWorktreePath(repoRoot: string, taskId: string): Promise<string> {
  const dir = taskWorkspaceDir(repoRoot)
  await ensureDir(dir)
  const base = `${slug(taskId)}-${createHash('sha1').update(`${repoRoot}:${taskId}`).digest('hex').slice(0, 8)}`
  const target = join(dir, base)
  if (!(await pathExists(target))) return target
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = join(dir, `${base}-${index}`)
    if (!(await pathExists(candidate))) return candidate
  }
  return join(dir, `${base}-${Date.now()}`)
}

export async function prepareTaskWorkspace(input: {
  workspaceRoot: string
  taskId: string
  existingWorkspaceRoot?: string
}): Promise<TaskWorkspacePrepareResult> {
  const sourceRoot = normalizeRoot(input.workspaceRoot)
  const existing = input.existingWorkspaceRoot?.trim()
  if (existing && await pathExists(existing)) {
    return {
      kind: 'workspace',
      sourceRoot,
      repoRoot: sourceRoot,
      workspaceRoot: resolve(existing),
      created: false
    }
  }
  const repoRoot = await findGitRoot(sourceRoot)
  if (!repoRoot) {
    const fallback = existing && await pathExists(existing)
      ? resolve(existing)
      : await createSnapshotWorkspace(sourceRoot, input.taskId)
    return {
      kind: 'snapshot',
      sourceRoot,
      repoRoot: sourceRoot,
      workspaceRoot: fallback,
      created: !existing
    }
  }
  const target = await uniqueGitWorktreePath(repoRoot, input.taskId)
  if (!(await pathExists(target))) {
    await execFileAsync('git', ['worktree', 'add', '--detach', target], {
      cwd: repoRoot,
      timeout: 60_000,
      windowsHide: true
    })
  }
  return {
    kind: 'git-worktree',
    sourceRoot,
    repoRoot,
    workspaceRoot: target,
    ref: await runGit(repoRoot, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
    created: true
  }
}

export async function cleanupTaskWorkspace(workspaceRoot: string): Promise<void> {
  const target = resolve(workspaceRoot.trim())
  if (!target || target === resolve(homedir())) return
  await rm(target, { recursive: true, force: true })
}

export async function removeGitTaskWorktree(repoRoot: string, workspaceRoot: string): Promise<void> {
  const root = resolve(repoRoot.trim())
  const target = resolve(workspaceRoot.trim())
  if (!root || !target) return
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', target], {
      cwd: root,
      timeout: 60_000,
      windowsHide: true
    })
  } catch {
    await rm(target, { recursive: true, force: true })
  }
}

export async function archiveTaskWorkspace(workspaceRoot: string): Promise<void> {
  const target = resolve(workspaceRoot.trim())
  const archivedMarker = join(dirname(target), `${basename(target)}.archived`)
  await writeFile(archivedMarker, new Date().toISOString(), 'utf8')
}

async function createSnapshotWorkspace(sourceRoot: string, taskId: string): Promise<string> {
  const target = join(sourceRoot, DEFAULT_TASK_WORKTREE_DIR, `${slug(taskId)}-${Date.now()}`)
  await rm(target, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(target, { recursive: true })
  await cp(sourceRoot, target, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (src) => !shouldSkipSnapshotPath(src, sourceRoot, target)
  })
  return target
}

function shouldSkipSnapshotPath(path: string, sourceRoot: string, targetRoot: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  const source = sourceRoot.replace(/\\/g, '/')
  const target = targetRoot.replace(/\\/g, '/')
  if (normalized === source || normalized === target) return false
  if (normalized.startsWith(`${target}/`)) return true
  const rel = normalized.slice(source.length).replace(/^\/+/, '')
  if (!rel) return false
  const first = rel.split('/')[0] ?? ''
  return ['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'coverage', '.deepseekgui/task-workspaces'].includes(first)
}
