import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { guiOutputOptions, i18nChunkName } from "../build-chunks";

for (const separator of ["/", "\\"]) {
  test(`i18n chunk names stay stable with ${JSON.stringify(separator)} paths`, () => {
    for (const locale of ["en", "zh-TW", "ru", "future-language"]) {
      expect(i18nChunkName(["root", "gui", "src", "i18n", `${locale}.ts`].join(separator)))
        .toBe(`i18n-${locale}`);
    }
    expect(i18nChunkName(["root", "gui", "src", "pages", "en.ts"].join(separator))).toBeNull();
    expect(i18nChunkName(["root", "gui", "src", "i18n", "provider.tsx"].join(separator))).toBeNull();
  });
}

test("Vite enables ordered partitioning without overriding its warning threshold", async () => {
  const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  expect(source).toContain("output: guiOutputOptions");
  expect(source).not.toContain("chunkSizeWarningLimit");
  expect(guiOutputOptions.strictExecutionOrder).toBe(true);
  expect(guiOutputOptions.codeSplitting).toMatchObject({ includeDependenciesRecursively: false });
});

test("real chunks preserve synchronous catalogs, import order, and deferred page effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocx-gui-chunks-"));
  const sources: Record<string, string> = {
    "src/state.ts": "export const trace = [];",
    "src/i18n/en.ts": "import {trace} from '../state'; trace.push('en'); export const en = {title: 'English'};",
    "src/i18n/ru.ts": "import {trace} from '../state'; trace.push('ru'); export const ru = {title: 'Русский'};",
    "src/i18n/catalogs.ts": "import {en} from './en'; import {ru} from './ru'; export const DICTS = {en, ru};",
    "src/pages/first.ts": "import {trace} from '../state'; trace.push('first'); export const first = 1;",
    "src/pages/late.ts": "import {trace} from '../state'; trace.push('late'); export const late = 2;",
    "src/main.ts": "import {trace} from './state'; import {DICTS} from './i18n/catalogs'; import {first} from './pages/first'; trace.push('entry'); export {trace, DICTS, first}; export const loadLate = () => import('./pages/late');",
  };
  let bundle: Awaited<ReturnType<typeof rolldown>> | undefined;
  try {
    for (const [file, contents] of Object.entries(sources)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), contents);
    }
    // Keep fixture exports inspectable; Vite application builds already use false.
    bundle = await rolldown({ input: join(root, "src/main.ts"), preserveEntrySignatures: "allow-extension", onwarn: warning => { throw new Error(warning.message); } });
    const result = await bundle.write({ ...guiOutputOptions, dir: join(root, "dist"), format: "esm",
      entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" });
    const chunks = result.output.filter(output => output.type === "chunk");
    expect(chunks.some(chunk => chunk.fileName.startsWith("i18n-en-"))).toBe(true);
    expect(chunks.some(chunk => chunk.fileName.startsWith("i18n-ru-"))).toBe(true);
    const loaded = await import(pathToFileURL(join(root, "dist/entry.mjs")).href);
    expect(loaded.DICTS).toEqual({ en: { title: "English" }, ru: { title: "Русский" } });
    expect(loaded.trace).toEqual(["en", "ru", "first", "entry"]);
    expect(loaded.first).toBe(1);
    expect((await loaded.loadLate()).late).toBe(2);
    expect(loaded.trace).toEqual(["en", "ru", "first", "entry", "late"]);
    await loaded.loadLate();
    expect(loaded.trace.filter((value: string) => value === "late")).toHaveLength(1);
  } finally {
    await bundle?.close();
    await rm(root, { recursive: true, force: true });
  }
});
