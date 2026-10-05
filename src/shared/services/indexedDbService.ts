import type { LatencyProject } from "../domain/types";

const DATABASE = "latency-lab-db";
const META_STORE = "workspace-meta";
const PROJECT_STORE = "workspace-projects";
const LEGACY_STORE = "workspace";
const META_KEY = "current";
const LEGACY_KEY = "latency-lab.workspace.v1";

export interface WorkspaceMetaRecord {
  revision: number;
  activeProjectId: string;
  projectIds: string[];
}

export interface WorkspaceChanges {
  meta: WorkspaceMetaRecord;
  upserts: LatencyProject[];
  removedIds: string[];
  /** 首次完成迁移并收敛后，删除旧版整份工作区记录。 */
  clearLegacy?: boolean;
}

export interface WorkspaceSnapshot {
  meta?: WorkspaceMetaRecord;
  projects: unknown[];
  /** 旧版整份工作区记录（v1 升级后第一次读取时存在）。 */
  legacy?: unknown;
}

export class IndexedDbService {
  async read(): Promise<WorkspaceSnapshot> {
    if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [
          META_STORE,
          PROJECT_STORE,
          ...(db.objectStoreNames.contains(LEGACY_STORE) ? [LEGACY_STORE] : []),
        ],
        "readonly",
      );
      let meta: WorkspaceMetaRecord | undefined;
      const projects: unknown[] = [];
      let legacy: unknown;
      transaction.objectStore(META_STORE).get(META_KEY).onsuccess = (event) => {
        meta = (event.target as IDBRequest).result as
          WorkspaceMetaRecord | undefined;
      };
      transaction.objectStore(PROJECT_STORE).openCursor().onsuccess = (
        event,
      ) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          projects.push(cursor.value);
          cursor.continue();
        }
      };
      if (db.objectStoreNames.contains(LEGACY_STORE))
        transaction.objectStore(LEGACY_STORE).get(LEGACY_KEY).onsuccess = (
          event,
        ) => {
          legacy = (event.target as IDBRequest).result;
        };
      transaction.oncomplete = () => {
        const normalizedMeta =
          typeof meta === "object" &&
          meta !== null &&
          typeof meta.revision === "number"
            ? meta
            : undefined;
        resolve({ meta: normalizedMeta, projects, legacy });
      };
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("读取本地项目失败"));
    });
  }

  /**
   * 按项目写入：先落项目行（含删除），再提交 meta 索引；
   * 全部在同一个事务内完成，IndexedDB 自身保证原子性。
   */
  async write(changes: WorkspaceChanges): Promise<void> {
    if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const stores = [META_STORE, PROJECT_STORE];
      if (changes.clearLegacy && db.objectStoreNames.contains(LEGACY_STORE))
        stores.push(LEGACY_STORE);
      const transaction = db.transaction(stores, "readwrite");
      const projectStore = transaction.objectStore(PROJECT_STORE);
      for (const project of changes.upserts)
        projectStore.put(project, project.id);
      for (const id of changes.removedIds) projectStore.delete(id);
      transaction.objectStore(META_STORE).put(changes.meta, META_KEY);
      if (changes.clearLegacy && db.objectStoreNames.contains(LEGACY_STORE))
        transaction.objectStore(LEGACY_STORE).delete(LEGACY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("保存本地项目失败"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("保存已中断"));
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECT_STORE))
          db.createObjectStore(PROJECT_STORE);
        if (!db.objectStoreNames.contains(META_STORE))
          db.createObjectStore(META_STORE);
        // v1 → v2：把整份工作区拆成 meta + 单项目行，保留原记录交给仓储层解析/清理。
        if (db.objectStoreNames.contains(LEGACY_STORE)) {
          const migration = request.transaction;
          if (migration) {
            const legacyStore = migration.objectStore(LEGACY_STORE);
            legacyStore.get(LEGACY_KEY).onsuccess = (event) => {
              const legacy = (event.target as IDBRequest).result as unknown;
              if (!isLegacyDocument(legacy)) return;
              const projectStore = migration.objectStore(PROJECT_STORE);
              for (const project of legacy.projects)
                if (isProjectLike(project))
                  projectStore.put(project, String(project.id));
              migration.objectStore(META_STORE).put(
                {
                  revision: 1,
                  activeProjectId: String(legacy.activeProjectId ?? ""),
                  projectIds: legacy.projects
                    .filter(isProjectLike)
                    .map((project) => String(project.id)),
                } satisfies WorkspaceMetaRecord,
                META_KEY,
              );
            };
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("打开本地项目失败"));
    });
  }
}

function isLegacyDocument(
  value: unknown,
): value is { activeProjectId: unknown; projects: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { projects?: unknown }).projects)
  );
}

function isProjectLike(value: unknown): value is { id: unknown } {
  return typeof value === "object" && value !== null;
}
