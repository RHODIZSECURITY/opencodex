import type { OutputOptions } from "rolldown";

const i18nModule = /[\\/]src[\\/]i18n[\\/]([^\\/]+)\.ts$/;

/** Stable per-module catalogs retain their synchronous API and independent cache keys. */
export function i18nChunkName(id: string): string | null {
  const match = i18nModule.exec(id);
  return match ? `i18n-${match[1]}` : null;
}

/** Partition eager GUI modules without changing when their initialization takes place. */
export const guiOutputOptions: OutputOptions = {
  // Manual groups can otherwise evaluate shared modules before their original importers.
  strictExecutionOrder: true,
  codeSplitting: {
    includeDependenciesRecursively: false,
    groups: [
      { name: i18nChunkName, test: i18nModule, priority: 30 },
      { name: "gui-vendor", test: /[\\/]node_modules[\\/]/, maxSize: 250_000, priority: 20 },
      { name: "gui-pages", test: /[\\/]src[\\/]pages[\\/]/, maxSize: 250_000, priority: 10 },
      { name: "gui-shared", test: /[\\/]src[\\/]/, maxSize: 250_000 },
    ],
  },
};
