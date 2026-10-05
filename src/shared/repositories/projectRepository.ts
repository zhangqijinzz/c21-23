import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import {
  IndexedDbService,
  type WorkspaceChanges,
  type WorkspaceMetaRecord,
  type WorkspaceSnapshot,
} from "../services/indexedDbService";

const LS_META_KEY = "latency-lab.workspace.v2.meta";
const LS_PROJECT_PREFIX = "latency-lab.workspace.v2.project.";
const LEGACY_FALLBACK_KEY = "latency-lab.workspace.v1";
const START_REVISION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNode(value: unknown): RequestNode | undefined {
  if (!isRecord(value)) return undefined;
  const {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds,
    timeoutMs,
    retryCount,
    failureRate,
    fallbackNodeId,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !Array.isArray(dependencyIds)
  )
    return undefined;
  if (
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(jitterMs) ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(retryCount) ||
    !isFiniteNumber(failureRate)
  )
    return undefined;
  return {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds: dependencyIds.filter(
      (id): id is string => typeof id === "string",
    ),
    timeoutMs,
    retryCount,
    failureRate,
    ...(typeof fallbackNodeId === "string" ? { fallbackNodeId } : {}),
  };
}

function parseScenario(value: unknown): ScenarioSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.criticalPath)
  )
    return undefined;
  const { id, name, createdAt, concurrencyLimit, completionMs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof createdAt !== "number" ||
    typeof completionMs !== "number"
  )
    return undefined;
  return {
    id,
    name,
    createdAt,
    completionMs,
    concurrencyLimit:
      typeof concurrencyLimit === "number" && concurrencyLimit > 0
        ? concurrencyLimit
        : null,
    nodes: value.nodes
      .map(parseNode)
      .filter((node): node is RequestNode => Boolean(node)),
    criticalPath: value.criticalPath.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function parseProject(
  value: unknown,
): { project: LatencyProject; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const parsedNodes = sourceNodes.map(parseNode);
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let recovered =
    !Array.isArray(value.nodes) || nodes.length !== sourceNodes.length;
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter(
      (id) => id !== node.id && nodeIds.has(id),
    );
    const validFallback =
      node.fallbackNodeId &&
      node.fallbackNodeId !== node.id &&
      nodeIds.has(node.fallbackNodeId)
        ? node.fallbackNodeId
        : undefined;
    if (
      dependencyIds.length !== node.dependencyIds.length ||
      validFallback !== node.fallbackNodeId
    )
      recovered = true;
    return {
      ...node,
      dependencyIds,
      ...(validFallback
        ? { fallbackNodeId: validFallback }
        : { fallbackNodeId: undefined }),
    };
  });
  const scenarioSource = Array.isArray(value.scenarios) ? value.scenarios : [];
  const scenarios = scenarioSource
    .map(parseScenario)
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (
    !Array.isArray(value.scenarios) ||
    scenarios.length !== scenarioSource.length
  )
    recovered = true;
  const now = Date.now();
  const project: LatencyProject = {
    id: value.id,
    title: value.title,
    nodes: safeNodes,
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit > 0
        ? Math.floor(value.concurrencyLimit)
        : null,
    scenarios,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  return { project, recovered };
}

/** 解析 v1 整份工作区（旧 IndexedDB 记录或旧 localStorage 恢复副本）。 */
function parseLegacyWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || !Array.isArray(value.projects)) return undefined;
  const parsed = value.projects.map(parseProject);
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  return { document: { activeProjectId, projects }, recovered };
}

function toMetaRecord(value: unknown): WorkspaceMetaRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    !Number.isFinite(value.revision) ||
    typeof value.activeProjectId !== "string" ||
    !Array.isArray(value.projectIds)
  )
    return undefined;
  return {
    revision: Math.floor(value.revision),
    activeProjectId: value.activeProjectId,
    projectIds: value.projectIds.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

/** v2 单层数据：IndexedDB 或 localStorage 解析后的统一形态。 */
interface StorageLayer {
  origin: "idb" | "local";
  revision: number;
  activeProjectId: string;
  projectIds: string[];
  projects: Map<string, LatencyProject>;
  /** meta 索引缺失、只能靠散落项目重建。 */
  rebuilt: boolean;
  repaired: boolean;
}

interface LayerBuild {
  layer?: StorageLayer;
  /** 不在 meta 索引内的项目行（如新增写入中断在索引提交之前）。 */
  orphans: LatencyProject[];
}

function buildLayer(
  origin: "idb" | "local",
  meta: WorkspaceMetaRecord | undefined,
  rows: unknown[],
): LayerBuild {
  const parsed = rows
    .map(parseProject)
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    );
  const projects = new Map(
    parsed.map((entry) => [entry.project.id, entry.project]),
  );
  let repaired = parsed.some((entry) => entry.recovered);

  if (!meta) {
    // 索引不在：用散落项目按最后修改时间重建，整体恢复仍可用。
    if (!projects.size) return { orphans: [] };
    const rebuiltProjects = [...projects.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    return {
      layer: {
        origin,
        revision: 0,
        activeProjectId: rebuiltProjects[0]!.id,
        projectIds: rebuiltProjects.map((project) => project.id),
        projects,
        rebuilt: true,
        repaired,
      },
      orphans: [],
    };
  }

  const indexed: string[] = [];
  for (const id of meta.projectIds) {
    if (projects.has(id)) indexed.push(id);
    else repaired = true; // 索引指向的项目丢失，丢弃该引用
  }
  const orphans = [...projects.values()]
    .filter((project) => !meta.projectIds.includes(project.id))
    .map((project) => project);
  for (const orphan of orphans) projects.delete(orphan.id);
  const activeProjectId = indexed.includes(meta.activeProjectId)
    ? meta.activeProjectId
    : (indexed[0] ?? "");
  if (activeProjectId !== meta.activeProjectId) repaired = true;
  if (!indexed.length) return { orphans };
  return {
    layer: {
      origin,
      revision: meta.revision,
      activeProjectId,
      projectIds: indexed,
      projects,
      rebuilt: false,
      repaired,
    },
    orphans,
  };
}

interface ReconciledWorkspace {
  document: WorkspaceDocument;
  revision: number;
  /** 数据经过修复、来自恢复副本或旧版迁移，需要提示用户。 */
  recovered: boolean;
  /** 发现旧版整份工作区数据，本次打开完成了自动转换。 */
  migrated: boolean;
  /** 两层不一致或缺损，载入后需要整体回写一次使结构收敛。 */
  needsNormalize: boolean;
}

/**
 * 两层数据仲裁：
 * revision 较大的一层是最新完整状态；相同 revision 以 IndexedDB 为准。
 * 优胜层缺失的单个项目回退到另一层补齐；一方完全不可读时使用另一方。
 */
function reconcileLayers(
  idb: LayerBuild,
  local: LayerBuild,
  hasLocalOrphans: boolean,
  hasIdbLegacy: boolean,
  hasLocalLegacy: boolean,
): ReconciledWorkspace | undefined {
  const winner =
    idb.layer && local.layer
      ? local.layer.revision > idb.layer.revision
        ? local.layer
        : idb.layer
      : (idb.layer ?? local.layer);
  const loser = winner === idb.layer ? local.layer : idb.layer;
  if (!winner) return undefined;

  let recovered = winner.rebuilt || winner.repaired;
  const projectIds: string[] = [];
  const projects: LatencyProject[] = [];
  for (const id of winner.projectIds) {
    const project = winner.projects.get(id) ?? loser?.projects.get(id);
    if (!project) {
      recovered = true;
      continue;
    }
    if (!winner.projects.has(id)) recovered = true;
    projectIds.push(id);
    projects.push(project);
  }
  if (!projects.length) return undefined;
  const activeProjectId = projectIds.includes(winner.activeProjectId)
    ? winner.activeProjectId
    : projectIds[0]!;
  if (activeProjectId !== winner.activeProjectId) recovered = true;
  // 主存 IndexedDB 未能提供权威状态、只能依靠本地恢复副本时提示。
  if (winner.origin === "local") recovered = true;
  if (loser?.rebuilt || loser?.repaired) recovered = true;

  const needsNormalize =
    recovered ||
    !idb.layer ||
    !local.layer ||
    idb.layer.revision !== local.layer.revision ||
    idb.orphans.length > 0 ||
    local.orphans.length > 0 ||
    hasLocalOrphans ||
    hasIdbLegacy ||
    hasLocalLegacy;

  return {
    document: { activeProjectId, projects },
    revision: winner.revision,
    recovered,
    migrated: hasIdbLegacy || hasLocalLegacy,
    needsNormalize,
  };
}

export interface ProjectStorage {
  read(): Promise<WorkspaceSnapshot>;
  write(changes: WorkspaceChanges): Promise<void>;
}

interface Baseline {
  document: WorkspaceDocument;
  revision: number;
}

export class ProjectRepository {
  private baseline: Baseline | null = null;
  /** 确认已写入主存的项目行；基线来自内置示例时为空，首次保存会补齐。 */
  private persistedIds = new Set<string>();

  constructor(
    private readonly storage: ProjectStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<{
    document: WorkspaceDocument;
    recovered: boolean;
    migrated: boolean;
    /** 没有任何历史数据，载入的是内置示例。 */
    seeded: boolean;
  }> {
    let snapshot: WorkspaceSnapshot | undefined;
    try {
      snapshot = await this.storage.read();
    } catch {
      snapshot = undefined;
    }

    const idbBuild = snapshot
      ? buildLayer("idb", snapshot.meta, snapshot.projects)
      : { orphans: [] as LatencyProject[] };
    const localBuild = this.readLocalLayer();
    const idbLegacy = snapshot?.legacy
      ? parseLegacyWorkspace(snapshot.legacy)
      : undefined;
    const localLegacy = this.readLegacyLocal();

    let reconciled = reconcileLayers(
      idbBuild,
      localBuild.layerBuild,
      localBuild.orphanKeys.length > 0,
      Boolean(idbLegacy),
      Boolean(localLegacy),
    );

    if (!reconciled) {
      const legacy = idbLegacy ?? localLegacy;
      if (legacy) {
        reconciled = {
          document: legacy.document,
          revision: START_REVISION,
          recovered: true,
          migrated: true,
          needsNormalize: true,
        };
      }
    }

    if (!reconciled) {
      const document: WorkspaceDocument = {
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      };
      this.baseline = { document, revision: 0 };
      return { document, recovered: true, migrated: false, seeded: true };
    }

    this.baseline = {
      document: reconciled.document,
      revision: reconciled.revision,
    };
    this.persistedIds = new Set(
      reconciled.document.projects.map((project) => project.id),
    );
    if (reconciled.needsNormalize) {
      try {
        await this.persist(reconciled.document, reconciled.revision, true);
      } catch {
        // 收敛回写失败不影响本次载入，后续编辑保存会再次尝试。
      }
    }
    return {
      document: reconciled.document,
      recovered: reconciled.recovered,
      migrated: reconciled.migrated,
      seeded: false,
    };
  }

  /**
   * 按项目保存：相对上次已持久化的工作区，只写新增/变化的项目与索引，
   * 删除的项目单独清除。IndexedDB 失败时仍尝试写本地恢复副本。
   */
  async save(document: WorkspaceDocument): Promise<void> {
    const base = this.baseline ?? { document: emptyDocument(), revision: 0 };
    await this.persist(document, base.revision + 1, false, base.document);
  }

  private async persist(
    document: WorkspaceDocument,
    revision: number,
    normalize: boolean,
    baseDocument?: WorkspaceDocument,
  ): Promise<void> {
    const previous = baseDocument ?? this.baseline?.document;
    const previousById = new Map(
      (previous?.projects ?? []).map((project) => [project.id, project]),
    );
    const currentIds = new Set(document.projects.map((project) => project.id));
    const upserts = normalize
      ? document.projects
      : document.projects.filter(
          (project) =>
            !this.persistedIds.has(project.id) ||
            !sameProject(previousById.get(project.id), project),
        );
    const removedIds = normalize
      ? []
      : [...this.persistedIds].filter((id) => !currentIds.has(id));
    const meta: WorkspaceMetaRecord = {
      revision,
      activeProjectId: document.activeProjectId,
      projectIds: document.projects.map((project) => project.id),
    };

    let storageError: unknown;
    try {
      await this.storage.write({
        meta,
        upserts,
        removedIds,
        ...(normalize ? { clearLegacy: true } : {}),
      });
    } catch (error) {
      storageError = error;
    }

    let localError: unknown;
    try {
      this.writeLocalLayer(meta, upserts, removedIds, normalize);
    } catch (error) {
      localError = error;
    }
    if (storageError) throw storageError;
    if (localError) throw localError;
    this.baseline = { document, revision };
    this.persistedIds = currentIds;
  }

  private readLocalLayer(): {
    layerBuild: LayerBuild;
    orphanKeys: string[];
  } {
    let meta: WorkspaceMetaRecord | undefined;
    const rawMeta = localStorage.getItem(LS_META_KEY);
    if (rawMeta) {
      try {
        meta = toMetaRecord(JSON.parse(rawMeta) as unknown);
      } catch {
        meta = undefined;
      }
    }
    const rows: unknown[] = [];
    if (meta) {
      for (const id of meta.projectIds) {
        const raw = localStorage.getItem(LS_PROJECT_PREFIX + id);
        if (raw) {
          try {
            rows.push(JSON.parse(raw) as unknown);
          } catch {
            rows.push(undefined);
          }
        }
      }
    }
    const orphanKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LS_PROJECT_PREFIX)) {
        const id = key.slice(LS_PROJECT_PREFIX.length);
        if (!meta || !meta.projectIds.includes(id)) {
          orphanKeys.push(key);
          if (!meta) {
            const raw = localStorage.getItem(key);
            if (raw) {
              try {
                rows.push(JSON.parse(raw) as unknown);
              } catch {
                // 损坏的散落项目忽略，重建其余部分
              }
            }
          }
        }
      }
    }
    return { layerBuild: buildLayer("local", meta, rows), orphanKeys };
  }

  private readLegacyLocal():
    { document: WorkspaceDocument; recovered: boolean } | undefined {
    const raw = localStorage.getItem(LEGACY_FALLBACK_KEY);
    if (!raw) return undefined;
    try {
      return parseLegacyWorkspace(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }

  private writeLocalLayer(
    meta: WorkspaceMetaRecord,
    upserts: LatencyProject[],
    removedIds: string[],
    normalize: boolean,
  ): void {
    // 项目键先写、索引键最后提交，保证恢复副本始终可整体恢复。
    for (const project of upserts)
      localStorage.setItem(
        LS_PROJECT_PREFIX + project.id,
        JSON.stringify(project),
      );
    for (const id of removedIds)
      localStorage.removeItem(LS_PROJECT_PREFIX + id);
    if (normalize) {
      const liveIds = new Set(meta.projectIds);
      const staleKeys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (
          key?.startsWith(LS_PROJECT_PREFIX) &&
          !liveIds.has(key.slice(LS_PROJECT_PREFIX.length))
        )
          staleKeys.push(key);
      }
      for (const key of staleKeys) localStorage.removeItem(key);
      localStorage.removeItem(LEGACY_FALLBACK_KEY);
    }
    localStorage.setItem(LS_META_KEY, JSON.stringify(meta));
  }
}

function emptyDocument(): WorkspaceDocument {
  return { activeProjectId: "", projects: [] };
}

function sameProject(
  before: LatencyProject | undefined,
  after: LatencyProject,
) {
  if (before === after) return true;
  if (!before) return false;
  return JSON.stringify(before) === JSON.stringify(after);
}
