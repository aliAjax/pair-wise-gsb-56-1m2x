import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'
import { backfillBaselines } from './reconciliation'

const STORAGE_KEY = 'export-control-review-v1'

/** 兼容旧版本存档：补齐核对链新增的集合，并按当前引用版本回填冻结基线 */
function migrate(state: WorkspaceState): WorkspaceState {
  let changed = false
  if (!Array.isArray(state.reservations)) {
    state.reservations = []
    changed = true
  }
  if (!Array.isArray(state.licenses)) {
    state.licenses = []
    changed = true
  }
  const before = state.packages.filter((item) => item.frozenBaseline).length
  backfillBaselines(state)
  const after = state.packages.filter((item) => item.frozenBaseline).length
  if (after !== before) changed = true
  if (changed) saveWorkspace(state)
  return state
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  try {
    return migrate(JSON.parse(raw) as WorkspaceState)
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
