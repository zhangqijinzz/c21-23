import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
  type WorkspaceMeta,
} from "../domain/types";
import { IndexedDbService } from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";

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

function parseWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
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
  return { document: { version: 1, activeProjectId, projects }, recovered };
}

function parseMeta(value: unknown): WorkspaceMeta | undefined {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.activeProjectId !== "string" ||
    !Array.isArray(value.projectIds)
  )
    return undefined;
  const projectIds = value.projectIds.filter(
    (id): id is string => typeof id === "string",
  );
  if (!projectIds.length) return undefined;
  return {
    version: 2,
    activeProjectId: value.activeProjectId,
    projectIds,
    savedAt: isFiniteNumber(value.savedAt) ? value.savedAt : 0,
  };
}

interface AssembledWorkspace {
  document: WorkspaceDocument;
  savedAt: number;
  recovered: boolean;
}

function assembleWorkspace(
  metaValue: unknown,
  projectValues: unknown[],
): AssembledWorkspace | undefined {
  const byId = new Map<
    string,
    { project: LatencyProject; recovered: boolean }
  >();
  for (const value of projectValues) {
    const parsed = parseProject(value);
    if (parsed) byId.set(parsed.project.id, parsed);
  }
  const meta = parseMeta(metaValue);
  if (!meta) {
    // 元信息缺失时仍可按项目记录整体恢复，顺序以记录为准
    if (!byId.size) return undefined;
    const projects = [...byId.values()].map((entry) => entry.project);
    const firstProject = projects[0];
    if (!firstProject) return undefined;
    return {
      document: { version: 1, activeProjectId: firstProject.id, projects },
      savedAt: Math.max(0, ...projects.map((project) => project.updatedAt)),
      recovered: true,
    };
  }
  let recovered = false;
  const projects: LatencyProject[] = [];
  for (const id of meta.projectIds) {
    const entry = byId.get(id);
    if (!entry) {
      recovered = true;
      continue;
    }
    if (entry.recovered) recovered = true;
    projects.push(entry.project);
  }
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === meta.activeProjectId,
  )
    ? meta.activeProjectId
    : firstProject.id;
  if (activeProjectId !== meta.activeProjectId) recovered = true;
  return {
    document: { version: 1, activeProjectId, projects },
    savedAt: meta.savedAt,
    recovered,
  };
}

interface FallbackSnapshot {
  document: WorkspaceDocument;
  savedAt: number;
  recovered: boolean;
}

function parseFallback(value: unknown): FallbackSnapshot | undefined {
  // 新格式 { savedAt, document }；旧格式直接是整份工作区文档
  if (isRecord(value) && "document" in value) {
    const parsed = parseWorkspace(value.document);
    if (!parsed) return undefined;
    return {
      ...parsed,
      savedAt: isFiniteNumber(value.savedAt) ? value.savedAt : 0,
    };
  }
  const parsed = parseWorkspace(value);
  if (!parsed) return undefined;
  return {
    ...parsed,
    savedAt: Math.max(
      0,
      ...parsed.document.projects.map((project) => project.updatedAt),
    ),
  };
}

export interface ProjectStorage {
  load(): Promise<{ meta: unknown; projects: unknown[]; legacy: unknown }>;
  save(
    meta: WorkspaceMeta,
    upsert: LatencyProject[],
    removeIds: string[],
  ): Promise<void>;
}

export class ProjectRepository {
  /** IndexedDB 写失败后置位，下一次保存自动全量补齐，避免增量漏写 */
  private needsFullSync = false;

  constructor(
    private readonly storage: ProjectStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<{ document: WorkspaceDocument; recovered: boolean }> {
    let primary: AssembledWorkspace | undefined;
    let legacy: unknown;
    try {
      const stored = await this.storage.load();
      primary = assembleWorkspace(stored.meta, stored.projects);
      legacy = stored.legacy;
    } catch {
      primary = undefined;
    }
    const fallback = this.readFallback();

    // 旧版整份工作区数据：首次打开自动拆分为按项目存储，内容不变
    if (!primary && legacy !== undefined) {
      const migrated = parseWorkspace(legacy);
      if (migrated) {
        await this.persistAll(migrated.document);
        return migrated;
      }
    }

    if (primary && fallback) {
      // 两层不一致时以保存时间较新的一份为准，并用它修复另一层
      if (fallback.savedAt > primary.savedAt) {
        await this.persistAll(fallback.document);
        return { document: fallback.document, recovered: true };
      }
      if (primary.recovered) await this.persistAll(primary.document);
      return { document: primary.document, recovered: primary.recovered };
    }
    if (primary) {
      if (primary.recovered) await this.persistAll(primary.document);
      return { document: primary.document, recovered: primary.recovered };
    }
    if (fallback) {
      await this.persistAll(fallback.document);
      return { document: fallback.document, recovered: true };
    }
    return {
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
    };
  }

  /**
   * 按项目保存：与上一份文档对比，仅写入发生变化的项目；
   * 不传 previous（或传 null）表示全量保存。本地恢复副本始终整份重写，
   * 保持可整体恢复的结构。
   */
  async save(
    document: WorkspaceDocument,
    previous?: WorkspaceDocument | null,
  ): Promise<void> {
    const savedAt = Date.now();
    const meta: WorkspaceMeta = {
      version: 2,
      activeProjectId: document.activeProjectId,
      projectIds: document.projects.map((project) => project.id),
      savedAt,
    };
    const fullSync = this.needsFullSync || !previous;
    const upsert = fullSync
      ? document.projects
      : document.projects.filter(
          (project) => !previous.projects.some((before) => before === project),
        );
    const nextIds = new Set(document.projects.map((project) => project.id));
    const removeIds = previous
      ? previous.projects
          .filter((project) => !nextIds.has(project.id))
          .map((project) => project.id)
      : [];
    let indexedDbError: unknown;
    try {
      await this.storage.save(meta, upsert, removeIds);
      this.needsFullSync = false;
    } catch (error) {
      this.needsFullSync = true;
      indexedDbError = error;
    }
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify({ savedAt, document }));
    } catch (error) {
      if (!indexedDbError) throw error;
    }
    if (indexedDbError) throw indexedDbError;
  }

  private readFallback(): FallbackSnapshot | undefined {
    const local = localStorage.getItem(FALLBACK_KEY);
    if (!local) return undefined;
    try {
      return parseFallback(JSON.parse(local) as unknown);
    } catch {
      localStorage.removeItem(FALLBACK_KEY);
      return undefined;
    }
  }

  /** 用胜出的一份数据修复另一层；失败不影响本次载入 */
  private async persistAll(document: WorkspaceDocument): Promise<void> {
    try {
      await this.save(document, null);
    } catch {
      // 恢复写入失败时保留内存中的数据，下次保存会再次尝试
    }
  }
}
