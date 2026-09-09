export const EXTENSION_CATEGORIES = [
  "search",
  "geospatial",
  "scheduling",
  "security",
  "observability",
  "utility",
] as const;
export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number];

export interface ExtensionState {
  name: string;
  title: string;
  description: string | null;
  category: ExtensionCategory | null;
  docsUrl: string | null;
  /** Installed version, or null when available but not enabled. */
  installedVersion: string | null;
  /** Newest version this project's image can provide. */
  defaultVersion: string | null;
  updateAvailable: boolean;
  /**
   * Enabling this restarts the database.
   *
   * `shared_preload_libraries` is read once at startup, so a library that was
   * not loaded then cannot be loaded later. There is no instant path.
   */
  requiresRestart: boolean;
  /** Already present in this project's shared_preload_libraries. */
  preloaded: boolean;
  /** False when the project's image does not ship it at all. */
  availableInImage: boolean;
  comment: string | null;
}
