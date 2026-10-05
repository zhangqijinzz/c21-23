import type { LatencyProject, WorkspaceMeta } from "../domain/types";

const DATABASE = "latency-lab-db";
const VERSION = 2;
const LEGACY_STORE = "workspace";
const LEGACY_KEY = "latency-lab.workspace.v1";
const PROJECT_STORE = "projects";
const META_STORE = "meta";
const META_KEY = "workspace";

export interface StoredWorkspace {
  meta: unknown;
  projects: unknown[];
  legacy: unknown;
}

export class IndexedDbService {
  async load(): Promise<StoredWorkspace> {
    assertSupported();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [META_STORE, PROJECT_STORE, LEGACY_STORE],
        "readonly",
      );
      const metaRequest = transaction.objectStore(META_STORE).get(META_KEY);
      const projectsRequest = transaction.objectStore(PROJECT_STORE).getAll();
      const legacyRequest = transaction
        .objectStore(LEGACY_STORE)
        .get(LEGACY_KEY);
      transaction.oncomplete = () =>
        resolve({
          meta: metaRequest.result as unknown,
          projects: (projectsRequest.result as unknown[]) ?? [],
          legacy: legacyRequest.result as unknown,
        });
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("读取本地项目失败"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("读取已中断"));
    });
  }

  async save(
    meta: WorkspaceMeta,
    upsert: LatencyProject[],
    removeIds: string[],
  ): Promise<void> {
    assertSupported();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [META_STORE, PROJECT_STORE, LEGACY_STORE],
        "readwrite",
      );
      const projects = transaction.objectStore(PROJECT_STORE);
      for (const project of upsert) projects.put(project);
      for (const id of removeIds) projects.delete(id);
      transaction.objectStore(META_STORE).put(meta, META_KEY);
      // 迁移完成后清除整份旧数据，已迁移过的保存里这是无操作
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
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // 旧版整份工作区 store 保留用于迁移读取
        if (!db.objectStoreNames.contains(LEGACY_STORE))
          db.createObjectStore(LEGACY_STORE);
        if (!db.objectStoreNames.contains(PROJECT_STORE))
          db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(META_STORE))
          db.createObjectStore(META_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("打开本地项目失败"));
    });
  }
}

function assertSupported(): void {
  if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
}
